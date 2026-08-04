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
  private readonly senderId: string;
  private readonly baseUrl = 'https://2factor.in/API/V1';

  constructor(private readonly config: ConfigService) {
    this.apiKey = this.config.get<string>('sms.twoFactor.apiKey') ?? '';
    this.templateName =
      this.config.get<string>('sms.twoFactor.templateName') ?? 'OTP';
    this.senderId = this.config.get<string>('sms.twoFactor.senderId') ?? 'STMSG';
  }

  get name(): string {
    return '2factor';
  }

  get priority(): number {
    return 1; // Primary provider
  }

  isHealthy(): Promise<boolean> {
    return Promise.resolve(!!this.apiKey);
  }

  async sendSms(params: SendSmsParams): Promise<SendSmsResult> {
    // A template with more than one variable cannot be filled by the OTP
    // endpoint (it only substitutes the OTP), so 2Factor would leave the other
    // variables empty and fall back to a voice call. The transactional
    // endpoint takes the fully rendered message instead.
    if (params.multiVariable) {
      return this.sendTransactional(params);
    }

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
    const templateName =
      params.templateIdentifiers?.['2factor'] || this.templateName;
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
        failureReason: response.data.Details || 'Unknown error',
        errorType: 'service',
      };
    } catch (error: any) {
      const errorMessage = error?.response?.data?.Details || error?.message;
      this.logger.error(`2Factor.in API Error: ${errorMessage}`);
      return {
        providerMsgId: '',
        status: 'failed',
        failureReason: errorMessage,
        errorType: 'service',
      };
    }
  }

  /**
   * Sends a DLT-approved multi-variable template through 2Factor's
   * transactional endpoint. The fully rendered message is passed as `Msg`;
   * the operator's DLT scrubbing matches it against the approved template for
   * the sender header, so the variable boundaries in our stored body do not
   * have to line up with 2Factor's {#var#} slots — only the final text has to
   * match the approved content.
   *
   * Endpoint: POST /API/V1/{api_key}/ADDON_SERVICES/SEND/TSMS
   * Form fields: From (DLT header), To, Msg.
   */
  private async sendTransactional(
    params: SendSmsParams,
  ): Promise<SendSmsResult> {
    const url = `${this.baseUrl}/${this.apiKey}/ADDON_SERVICES/SEND/TSMS`;
    const form = new URLSearchParams({
      From: this.senderId,
      To: params.to,
      Msg: params.content,
    });

    try {
      this.logger.debug(
        `Sending 2Factor transactional SMS to ${params.to} (from ${this.senderId})`,
      );
      const response = await axios.post(url, form.toString(), {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      });

      if (response.data.Status === 'Success') {
        return {
          providerMsgId: String(response.data.Details), // message/session id
          status: 'sent',
        };
      }

      return {
        providerMsgId: '',
        status: 'failed',
        failureReason: response.data.Details || 'Unknown error',
        errorType: 'service',
      };
    } catch (error: any) {
      const errorMessage = error?.response?.data?.Details || error?.message;
      this.logger.error(`2Factor.in transactional API Error: ${errorMessage}`);
      return {
        providerMsgId: '',
        status: 'failed',
        failureReason: errorMessage,
        errorType: 'service',
      };
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  getDeliveryStatus(providerMsgId: string): Promise<DlrResult> {
    // 2Factor.in OTP API primarily uses webhooks for status updates.
    // The "PULL" API is not consistently documented for special OTP session IDs.
    // We return 'unknown' and rely on the webhook-driven flow.
    return Promise.resolve({
      status: 'unknown',
      description: 'DLR tracking handled via webhooks',
    });
  }

  private extractOtp(content: string): string | null {
    // Look for 4-6 digit numeric code
    const match = content.match(/\d{4,6}/);
    return match ? match[0] : null;
  }
}
