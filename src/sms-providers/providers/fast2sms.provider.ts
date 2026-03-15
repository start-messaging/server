import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  DlrResult,
  SendSmsParams,
  SendSmsResult,
  SmsProvider,
} from '../sms-provider.interface.js';

interface Fast2SmsResponse {
  return: boolean;
  request_id: string;
  message: string[] | string;
}

@Injectable()
export class Fast2SmsProvider implements SmsProvider {
  name = 'fast2sms';
  priority = 1;
  private readonly apiKey: string | undefined;
  private readonly route: string;
  private readonly senderId: string | undefined;
  private readonly dltTemplateId: string | undefined;
  private readonly logger = new Logger(Fast2SmsProvider.name);

  private static readonly BASE_URL = 'https://www.fast2sms.com/dev/bulkV2';
  private static readonly DLR_URL = 'https://www.fast2sms.com/dev/dlr';

  constructor(private readonly config: ConfigService) {
    this.apiKey = this.config.get<string>('sms.fast2sms.apiKey');
    this.route = this.config.get<string>('sms.fast2sms.route') ?? 'dlt';
    this.senderId = this.config.get<string>('sms.fast2sms.senderId');
    this.dltTemplateId = this.config.get<string>('sms.fast2sms.dltTemplateId');
  }

  async sendSms(params: SendSmsParams): Promise<SendSmsResult> {
    if (!this.apiKey) {
      throw new Error('Fast2SMS not configured');
    }

    // Strip +91 or +country code — Fast2SMS expects 10-digit Indian numbers
    const number = this.normalizeNumber(params.to);

    try {
      const body = this.buildRequestBody(number, params.content);

      const response = await fetch(Fast2SmsProvider.BASE_URL, {
        method: 'POST',
        headers: {
          authorization: this.apiKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });

      const data = (await response.json()) as Fast2SmsResponse;

      if (data.return) {
        return {
          providerMsgId: data.request_id ?? '',
          status: 'sent',
        };
      }

      const errorType =
        response.status >= 400 && response.status < 500
          ? 'validation'
          : 'service';

      return {
        providerMsgId: '',
        status: 'failed',
        failureReason: Array.isArray(data.message)
          ? data.message.join(', ')
          : (data.message ?? 'Unknown Fast2SMS error'),
        errorType,
      };
    } catch (err: any) {
      this.logger.error(`Fast2SMS send failed: ${err.message}`);
      return {
        providerMsgId: '',
        status: 'failed',
        failureReason: err.message,
        errorType: 'service' as const,
      };
    }
  }

  async getDeliveryStatus(providerMsgId: string): Promise<DlrResult> {
    if (!this.apiKey) {
      return { status: 'unknown' };
    }

    try {
      const url = `${Fast2SmsProvider.DLR_URL}?id=${encodeURIComponent(providerMsgId)}`;
      const response = await fetch(url, {
        method: 'GET',
        headers: { authorization: this.apiKey },
      });

      const data = (await response.json()) as any;

      if (!data.return || !data.data || !data.data[0]) {
        return { status: 'unknown', rawResponse: data };
      }

      const dlr = data.data[0].delivery_status?.[0];
      if (!dlr) {
        return { status: 'unknown', rawResponse: data };
      }

      const statusMap: Record<string, 'delivered' | 'failed' | 'sent' | 'unknown'> = {
        'delivered': 'delivered',
        'failed': 'failed',
        'rejected': 'failed',
        'sent': 'sent',
        'submitted': 'sent',
      };

      const normalizedStatus = (dlr.status || '').toLowerCase();
      let status: 'delivered' | 'failed' | 'sent' | 'unknown' = 'unknown';
      
      for (const [key, val] of Object.entries(statusMap)) {
        if (normalizedStatus.includes(key)) {
          status = val;
          break;
        }
      }

      return {
        status,
        description: dlr.status_description,
        senderId: dlr.sender_id,
        smsLanguage: dlr.sms_language,
        characterCount: dlr.character_count,
        smsCount: dlr.sms_count,
        providerCost: dlr.amount_debited ? parseFloat(dlr.amount_debited) : undefined,
        deliveredAt: dlr.delivery_timestamp ? new Date(dlr.delivery_timestamp * 1000) : undefined,
        rawResponse: data,
      };
    } catch (err: any) {
      this.logger.warn(`Fast2SMS DLR check failed: ${err.message}`);
      return { status: 'unknown' };
    }
  }

  isHealthy(): Promise<boolean> {
    return Promise.resolve(!!this.apiKey);
  }

  private normalizeNumber(phone: string): string {
    let num = phone.replace(/\s+/g, '');
    if (num.startsWith('+91')) {
      num = num.slice(3);
    } else if (num.startsWith('91') && num.length === 12) {
      num = num.slice(2);
    } else if (num.startsWith('+')) {
      num = num.slice(1);
    }
    return num;
  }

  private buildRequestBody(
    number: string,
    content: string,
  ): Record<string, string> {
    switch (this.route) {
      case 'otp':
        return {
          route: 'otp',
          variables_values: this.extractOtp(content),
          numbers: number,
        };

      case 'dlt':
        return {
          route: 'dlt',
          sender_id: this.senderId ?? '',
          message: this.dltTemplateId ?? '',
          variables_values: this.extractOtp(content),
          numbers: number,
        };

      case 'q':
      default:
        return {
          route: 'q',
          message: content,
          numbers: number,
          flash: '0',
        };
    }
  }

  private extractOtp(content: string): string {
    const match = content.match(/\b(\d{4,8})\b/);
    return match ? match[1] : content;
  }
}
