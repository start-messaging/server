import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import { Repository } from 'typeorm';
import { OtpRequest, OtpStatus } from './entities/otp-request.entity.js';
import {
  WalletService,
  InsufficientBalanceError,
} from '../wallet/wallet.service.js';
import { SmsProviderFactory } from '../sms-providers/sms-provider.factory.js';
import { MessagesService } from '../messages/messages.service.js';
import { MessageStatus } from '../messages/entities/message.entity.js';
import { ChannelsService } from '../channels/channels.service.js';
import { SendOtpDto } from './dto/send-otp.dto.js';
import { ErrorCodes } from '../common/constants/error-codes.constant.js';

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
  ) {
    this.expiryMinutes = this.config.get<number>('otp.expiryMinutes') ?? 5;
    this.costPerOtp = this.config.get<number>('otp.costPerOtp') ?? 0.25;
  }

  async send(userId: string, dto: SendOtpDto) {
    // Check wallet has sufficient balance before attempting send
    const wallet = await this.walletService.getWallet(userId);
    if (Number(wallet.balance) < this.costPerOtp) {
      throw new BadRequestException({
        code: ErrorCodes.INSUFFICIENT_BALANCE,
        message: 'Insufficient wallet balance',
      });
    }

    const otpRequest = this.otpRepository.create({
      userId,
      phoneNumber: dto.phoneNumber,
    });
    await this.otpRepository.save(otpRequest);

    // Debit wallet BEFORE sending SMS to prevent free sends
    try {
      await this.walletService.debit(
        userId,
        this.costPerOtp,
        'OTP send',
        'otp',
        otpRequest.id,
      );
    } catch (err) {
      if (err instanceof InsufficientBalanceError) {
        throw new BadRequestException({
          code: ErrorCodes.INSUFFICIENT_BALANCE,
          message: 'Insufficient wallet balance',
        });
      }
      throw err;
    }

    // Render template
    const smsContent = await this.renderOtpMessage(dto.otp, dto.templateId);

    // Send SMS
    const smsResult = await this.smsProviderFactory.send({
      to: dto.phoneNumber,
      content: smsContent,
    });

    const isFailed = smsResult.status === 'failed';

    if (isFailed) {
      // Refund wallet on SMS failure
      await this.walletService.credit(
        userId,
        this.costPerOtp,
        'OTP send refund — SMS failed',
        'refund',
        otpRequest.id,
      );
    } else {
      otpRequest.status = OtpStatus.SENT;
      await this.otpRepository.save(otpRequest);
    }

    // Record message
    const message = await this.messagesService.create({
      userId,
      otpRequestId: otpRequest.id,
      phoneNumber: dto.phoneNumber,
      content: `OTP sent`,
      provider: smsResult.provider,
      providerMsgId: smsResult.providerMsgId || null,
      status: isFailed ? MessageStatus.FAILED : MessageStatus.QUEUED,
      costAmount: isFailed ? 0 : this.costPerOtp,
      failureReason: smsResult.failureReason ?? null,
      sentAt: isFailed ? null : new Date(),
    });

    return {
      otpRequestId: otpRequest.id,
      messageId: message.id,
      status: smsResult.status,
    };
  }

  private async renderOtpMessage(
    otpCode: string,
    templateId?: string,
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

    return body
      .replace(/\{\{otp\}\}/g, otpCode)
      .replace(/\{\{expiry\}\}/g, String(this.expiryMinutes))
      .replace(/\{\{appName\}\}/g, appName);
  }
}
