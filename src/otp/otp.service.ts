import {
  BadRequestException,
  Injectable,
  Logger,
  Inject,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
// import { InjectQueue } from '@nestjs/bullmq';
// import { Queue } from 'bullmq';
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
    // @InjectQueue('sms-status') private readonly smsQueue: Queue,
  ) {
    this.expiryMinutes = this.config.get<number>('otp.expiryMinutes') ?? 5;
    this.costPerOtp = this.config.get<number>('otp.costPerOtp') ?? 0.25;
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

      // 6. Add to BullMQ for status polling ONLY if the provider is NOT 2factor
      // 2factor is handled purely via incoming webhooks.
      // if (smsResult.provider !== '2factor') {
      //   await this.smsQueue.add(
      //     'check-status',
      //     { messageId: message.id },
      //     {
      //       delay: 10000,
      //       attempts: 15,
      //       backoff: { type: 'exponential', delay: 30000 },
      //       removeOnComplete: true,
      //     },
      //   );
      // }

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

    const appName = this.config.get<string>('app.name') ?? 'StartMessaging';

    const defaults: Record<string, string> = {
      expiry: String(this.expiryMinutes),
      appName,
    };
    const merged = { ...defaults, ...variables };

    for (const [key, val] of Object.entries(merged)) {
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
