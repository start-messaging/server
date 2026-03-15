import {
  BadRequestException,
  Injectable,
  Logger,
  Inject,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { Repository } from 'typeorm';
import { OtpRequest, OtpStatus } from './entities/otp-request.entity.js';
import {
  WalletService,
} from '../wallet/wallet.service.js';
import { SmsProviderFactory } from '../sms-providers/sms-provider.factory.js';
import { MessagesService } from '../messages/messages.service.js';
import { MessageStatus } from '../messages/entities/message.entity.js';
import { ChannelsService } from '../channels/channels.service.js';
import { SendOtpDto } from './dto/send-otp.dto.js';
import { ErrorCodes } from '../common/constants/error-codes.constant.js';
import Redis from 'ioredis';

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
    @InjectQueue('sms-status') private readonly smsQueue: Queue,
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
    const smsContent = await this.renderOtpMessage(
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
      });

      if (smsResult.status === 'failed') {
        throw new Error(smsResult.failureReason || 'SMS Provider rejected request');
      }

      // 5. Create Message record as INITIATED
      const message = await this.messagesService.create({
        userId,
        otpRequestId: otpRequest.id,
        phoneNumber: dto.phoneNumber,
        content: `OTP sent`,
        provider: smsResult.provider,
        providerMsgId: smsResult.providerMsgId || null,
        status: MessageStatus.INITIATED,
        costAmount: this.costPerOtp,
        senderId: this.config.get<string>('sms.fast2sms.senderId'),
        apiKeyId,
      });

      // 6. Add to BullMQ for status polling (Start after 10 seconds)
      await this.smsQueue.add(
        'check-status',
        { messageId: message.id },
        {
          delay: 10000,
          attempts: 15,
          backoff: { type: 'exponential', delay: 30000 },
          removeOnComplete: true,
        },
      );

      return {
        otpRequestId: otpRequest.id,
        messageId: message.id,
        status: MessageStatus.INITIATED,
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
          failureReason: err.message,
          sentAt: null,
          apiKeyId,
        });
      } catch (msgErr) {
        this.logger.error(`Failed to record failed message for user ${userId}: ${msgErr.message}`);
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
  ): Promise<string> {
    let body: string | null = null;

    if (templateId) {
      const template = await this.channelsService.findTemplateById(templateId);
      if (template) {
        body = template.body;
      }
    }

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

    return body;
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
}
