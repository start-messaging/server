import {
  BadRequestException,
  Injectable,
  Logger,
  Inject,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import { Repository } from 'typeorm';
import { OtpRequest, OtpStatus } from './entities/otp-request.entity.js';
import { WalletService } from '../wallet/wallet.service.js';
import { SmsProviderFactory } from '../sms-providers/sms-provider.factory.js';
import { MessagesService } from '../messages/messages.service.js';
import { MessageStatus } from '../messages/entities/message.entity.js';
import { ChannelsService } from '../channels/channels.service.js';
import { SendOtpDto } from './dto/send-otp.dto.js';
import { ErrorCodes } from '../common/constants/error-codes.constant.js';
import Redis from 'ioredis';
import { GENERIC_FAILURE_REASON } from '../sms-providers/providers/two-factor-status.js';
import { OTP_COST_INR, OTP_EXPIRY_MINUTES } from './constants/otp.constant.js';
import { APP_NAME } from '../common/constants/app.constants.js';

/**
 * Masks digit runs before the rendered body is stored, so diagnosing a
 * template does not mean keeping every live OTP in a second place in clear.
 * Everything that matters for DLT matching — wording, spacing, stray variable
 * content — survives untouched.
 */
function maskOtpDigits(content: string): string {
  return content.replace(/\d{4,8}/g, (m) => '*'.repeat(m.length));
}

@Injectable()
export class OtpService {
  private readonly logger = new Logger(OtpService.name);
  private readonly expiryMinutes: number;
  private readonly costPerOtp: number;

  constructor(
    @InjectRepository(OtpRequest)
    private readonly otpRepository: Repository<OtpRequest>,
    private readonly walletService: WalletService,
    private readonly smsProviderFactory: SmsProviderFactory,
    private readonly messagesService: MessagesService,
    private readonly channelsService: ChannelsService,
    private readonly config: ConfigService,
    @Inject('REDIS_CLIENT') private readonly redis: Redis | null,
  ) {
    this.expiryMinutes = OTP_EXPIRY_MINUTES;
    this.costPerOtp = OTP_COST_INR;
  }

  async send(userId: string, dto: SendOtpDto, apiKeyId?: string) {
    // 1. Per-mobile number rate limit (Redis)
    await this.checkMobileRateLimit(dto.phoneNumber);

    // 2. Reserve Check (Pre-check balance)
    const wallet = await this.walletService.getWallet(userId);
    if (Number(wallet.balance) < this.costPerOtp) {
      throw new BadRequestException({
        code: ErrorCodes.INSUFFICIENT_BALANCE,
        message: 'Insufficient balance',
      });
    }

    // 3. Render Template
    const {
      body: smsContent,
      identifiers,
      multiVariable,
      templateId,
    } = await this.renderOtpMessage(
      dto.templateId,
      dto.variables as Record<string, string>,
    );

    const otpRequest = this.otpRepository.create({
      userId,
      phoneNumber: dto.phoneNumber,
      code: (dto.variables as any)?.otp || 'N/A',
      status: OtpStatus.PENDING,
      expiresAt: new Date(Date.now() + this.expiryMinutes * 60000),
    });
    await this.otpRepository.save(otpRequest);

    let smsResult;
    try {
      // 4. Trigger Send Immediately (Don't wait for final DLR)
      smsResult = await this.smsProviderFactory.send({
        to: dto.phoneNumber,
        content: smsContent,
        templateIdentifiers: identifiers,
        multiVariable,
      });

      if (smsResult.status === 'failed') {
        // Carries only the customer-safe reason. The provider's own wording
        // travels on smsResult.providerFailureReason and is persisted below
        // for admins, never returned in the HTTP error.
        throw new Error(smsResult.failureReason || GENERIC_FAILURE_REASON);
      }

      // 5. Create Message record using the provider's returned status (usually 'sent')
      const message = await this.messagesService.create({
        userId,
        otpRequestId: otpRequest.id,
        phoneNumber: dto.phoneNumber,
        content: `OTP sent`,
        provider: smsResult.provider,
        providerMsgId: smsResult.providerMsgId || null,
        status: this.mapResultStatus(smsResult.status),
        costAmount: 0,
        otpTemplateId: templateId,
        renderedContent: maskOtpDigits(smsContent),
        metadata: { intendedCost: this.costPerOtp },
        senderId:
          smsResult.provider === 'fast2sms'
            ? this.config.get<string>('sms.fast2sms.senderId')
            : undefined,
        apiKeyId,
      });

      // Settlement is not scheduled from here. A 2Factor OTP send is settled by
      // its delivery webhook, and anything that never produces one — every
      // transactional send — is picked up by the SMS reconcile sweep
      // (messages/queues/sms-reconcile.processor.ts). The commented-out
      // 'sms-status' queue that used to sit here belonged to a third,
      // never-registered path whose worker marked a message FAILED after five
      // minutes; that contradicts the sweep's 10-minute grace and 48-hour
      // window, and the two would have fought over billing state.

      return {
        otpRequestId: otpRequest.id,
        messageId: message.id,
        status: message.status,
        phoneNumber: dto.phoneNumber,
        createdAt: message.createdAt,
      };
    } catch (err) {
      // Decrement rate limit on failure
      await this.decrementMobileRateLimit(dto.phoneNumber);

      otpRequest.status = OtpStatus.FAILED;
      await this.otpRepository.save(otpRequest);

      // Record failed message for history
      try {
        await this.messagesService.create({
          userId,
          otpRequestId: otpRequest.id,
          phoneNumber: dto.phoneNumber,
          content: `OTP sent`,
          provider: smsResult?.provider || 'unknown',
          providerMsgId: smsResult?.providerMsgId || null,
          status: MessageStatus.FAILED,
          costAmount: 0,
          otpTemplateId: templateId,
          renderedContent: maskOtpDigits(smsContent),
          metadata: { intendedCost: this.costPerOtp },
          failureReason: err.message,
          providerFailureReason: smsResult?.providerFailureReason ?? null,
          sentAt: null,
          apiKeyId,
        });
      } catch (msgErr) {
        this.logger.error(
          `Failed to record failed message for user ${userId}: ${msgErr.message}`,
        );
      }

      throw new BadRequestException({
        code: ErrorCodes.OTP_SEND_FAILED,
        message: err.message || 'Failed to initiate OTP',
      });
    }
  }

  private async renderOtpMessage(
    templateId?: string,
    variables?: Record<string, string>,
  ): Promise<{
    body: string;
    identifiers: Record<string, string>;
    multiVariable: boolean;
    templateId: string | null;
  }> {
    let body: string | null = null;
    let identifiers: Record<string, string> = {};
    // The template that was actually resolved, not the one that was asked
    // for. A draft or deleted id falls through to the hardcoded body below,
    // and recording the requested id would then claim a template whose text
    // was never sent.
    let resolvedTemplateId: string | null = null;

    if (templateId) {
      const template = await this.channelsService.findTemplateById(templateId);
      if (template) {
        body = template.body;
        identifiers = (template.metadata as Record<string, string>) || {};
        resolvedTemplateId = template.id;
      }
    }

    // Count the template's variables before substitution. A registered
    // template with more than one {{variable}} cannot be delivered through
    // 2Factor's single-variable OTP endpoint (which only fills the OTP), so it
    // must go through the transactional path — otherwise 2Factor leaves the
    // other variables empty and falls back to a voice call. The fallback body
    // below is only reached when no template applies, and it uses the OTP
    // endpoint, so it is deliberately excluded from this count.
    const multiVariable =
      (body?.match(/\{\{\s*[a-zA-Z0-9_]+\s*\}\}/g) || []).length > 1;

    if (!body) {
      // Default fallback
      body = 'Your verification code is {{otp}}. Valid for {{expiry}} minutes.';
    }

    // A constant, not a lookup: `app.name` was never defined by any config
    // path or env var, so this always resolved to the literal. It is also the
    // one place a blank value would be actively harmful — the recipient would
    // read "Code 123456 for ." — and a constant cannot arrive empty.
    const appName = APP_NAME;

    const defaults: Record<string, string> = {
      expiry: String(this.expiryMinutes),
      appName,
    };

    // OtpVariablesDto declares `appName?` and `expiry?`, so a caller who omits
    // them still hands the service an object carrying those keys with the value
    // undefined. A plain `{ ...defaults, ...variables }` let that undefined win
    // over the default, and every customer who did not pass `expiry` was texted
    // "Valid for undefined minutes." — the highest-volume message this product
    // sends. Only a key that actually carries a string may beat its default.
    const supplied: Record<string, string> = {};
    for (const [key, val] of Object.entries(variables ?? {})) {
      if (typeof val === 'string') supplied[key] = val;
    }
    const merged: Record<string, string> = { ...defaults, ...supplied };

    for (const [key, val] of Object.entries(merged)) {
      // Belt to the above: `variables` is typed Record<string, string> but is
      // cast into this method from the DTO, so the type is a promise rather
      // than a guarantee. Anything that is not a string can only render as
      // "undefined", "null" or "[object Object]" in a customer's SMS, so it
      // never reaches the body — the placeholder stays visible instead, which
      // is at least diagnosable.
      if (typeof val !== 'string') {
        this.logger.warn(
          `Skipped non-string OTP template variable {{${key}}} (${typeof val})`,
        );
        continue;
      }
      body = body.replaceAll(`{{${key}}}`, val);
    }

    return { body, identifiers, multiVariable, templateId: resolvedTemplateId };
  }

  private async checkMobileRateLimit(phoneNumber: string) {
    if (!this.redis) return;

    const key = `limit:mobile:${phoneNumber}`;
    const count = await this.redis.incr(key);

    if (count === 1) {
      await this.redis.expire(key, 300); // 5 minutes
    }

    if (count > 3) {
      throw new BadRequestException({
        code: ErrorCodes.RATE_LIMIT_EXCEEDED,
        message:
          'Too many OTP requests for this mobile number. Please try again after 5 minutes.',
      });
    }
  }

  private async decrementMobileRateLimit(phoneNumber: string) {
    if (!this.redis) return;
    const key = `limit:mobile:${phoneNumber}`;
    const count = await this.redis.get(key);
    if (count && parseInt(count) > 0) {
      await this.redis.decr(key);
    }
  }

  private mapResultStatus(status: string): MessageStatus {
    switch (status) {
      case 'sent':
        return MessageStatus.SENT;
      case 'failed':
        return MessageStatus.FAILED;
      default:
        return MessageStatus.SENT;
    }
  }
}
