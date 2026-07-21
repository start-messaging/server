import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  SmsProvider,
  SendSmsParams,
  SendSmsResult,
  DlrResult,
} from '../sms-provider.interface.js';

/**
 * Dev/test SMS transport. Instead of hitting a real gateway it prints the
 * message (including the OTP code) to the server log, so OTP/message flows are
 * fully testable locally without any provider credentials.
 *
 * Activated when `SMS_DRIVER=console` (the default) or the legacy
 * `MOCK_SMS_SEND=true` flag is set. In production set `SMS_DRIVER=twofactor`.
 */
@Injectable()
export class ConsoleSmsProvider implements SmsProvider {
  private readonly logger = new Logger(ConsoleSmsProvider.name);

  constructor(private readonly config: ConfigService) {}

  get name(): string {
    return 'console';
  }

  get priority(): number {
    return 0; // Wins over real providers when enabled.
  }

  /** True when the console driver is selected. */
  isEnabled(): boolean {
    return (
      this.config.get<string>('sms.driver') === 'console' ||
      this.config.get<boolean>('MOCK_SMS_SEND') === true
    );
  }

  isHealthy(): Promise<boolean> {
    return Promise.resolve(this.isEnabled());
  }

  sendSms(params: SendSmsParams): Promise<SendSmsResult> {
    // Preserve the failure-simulation convention the test-suite relies on:
    // any content carrying the sentinel code 000000 is treated as a failure.
    if (params.content.includes('000000')) {
      this.logger.warn(`[CONSOLE SMS] Simulating failure to ${params.to}`);
      return Promise.resolve({
        providerMsgId: '',
        status: 'failed',
        failureReason: 'Simulated failure for testing',
        errorType: 'service',
      });
    }

    this.logger.log(
      `\n──────── CONSOLE SMS ────────\n  to:      ${params.to}\n  content: ${params.content}\n─────────────────────────────`,
    );

    return Promise.resolve({
      providerMsgId: `console_${Date.now()}`,
      status: 'sent',
    });
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  getDeliveryStatus(providerMsgId: string): Promise<DlrResult> {
    return Promise.resolve({
      status: 'delivered',
      description: 'Simulated delivery (console provider)',
      deliveredAt: new Date(),
      senderId: 'CONSOLE',
      smsLanguage: 'english',
      characterCount: 0,
      smsCount: 1,
      providerCost: 0,
    });
  }
}
