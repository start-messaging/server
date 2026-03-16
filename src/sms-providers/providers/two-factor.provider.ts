import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import {
  SmsProvider,
  SendSmsParams,
  SendSmsResult,
  DlrResult,
} from '../sms-provider.interface.js';

@Injectable()
export class TwoFactorProvider implements SmsProvider {
  private readonly logger = new Logger(TwoFactorProvider.name);
  private readonly apiKey: string;
  private readonly templateName: string;
  private readonly baseUrl = 'https://2factor.in/API/V1';

  constructor(private readonly config: ConfigService) {
    this.apiKey = this.config.get<string>('sms.twoFactor.apiKey') ?? '';
    this.templateName = this.config.get<string>('sms.twoFactor.templateName') ?? 'OTP1';
  }

  get name(): string {
    return '2factor';
  }

  get priority(): number {
    return 1; // Primary provider
  }

  async isHealthy(): Promise<boolean> {
    return !!this.apiKey;
  }

  async sendSms(params: SendSmsParams): Promise<SendSmsResult> {
    const otp = this.extractOtp(params.content);
    if (!otp) {
      this.logger.error('Failed to extract OTP from content for 2Factor.in');
      return {
        providerMsgId: '',
        status: 'failed',
        failureReason: 'Could not extract numeric OTP from content',
        errorType: 'validation',
      };
    }

    // Endpoint: https://2factor.in/API/V1/{api_key}/SMS/{phone_number}/{otp_val}/{template_name}
    const templateName = params.templateIdentifiers?.['2factor'] || this.templateName;
    const url = `${this.baseUrl}/${this.apiKey}/SMS/${params.to}/${otp}/${templateName}`;

    try {
      this.logger.debug(`Sending 2Factor SMS to ${params.to}`);
      const response = await axios.get(url);

      if (response.data.Status === 'Success') {
        return {
          providerMsgId: response.data.Details, // Detailed session ID
          status: 'sent',
        };
      }

      return {
        providerMsgId: '',
        status: 'failed',
        failureReason: response.data.Details || 'Unknown error from 2Factor.in',
        errorType: 'service',
      };
    } catch (error) {
      const errorMessage = error.response?.data?.Details || error.message;
      this.logger.error(`2Factor.in API Error: ${errorMessage}`);
      return {
        providerMsgId: '',
        status: 'failed',
        failureReason: errorMessage,
        errorType: 'service',
      };
    }
  }

  async getDeliveryStatus(providerMsgId: string): Promise<DlrResult> {
    // 2Factor.in OTP API primarily uses webhooks for status updates.
    // The "PULL" API is not consistently documented for special OTP session IDs.
    // We return 'unknown' and rely on the webhook-driven flow.
    return {
      status: 'unknown',
      description: 'DLR tracking handled via webhooks',
    };
  }

  private extractOtp(content: string): string | null {
    // Look for 4-6 digit numeric code
    const match = content.match(/\d{4,6}/);
    return match ? match[0] : null;
  }
}
