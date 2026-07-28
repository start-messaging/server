import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';
import {
  DlrResult,
  SendSmsParams,
  SendSmsResult,
  SmsProvider,
} from '../sms-provider.interface.js';

/**
 * Development SMS provider that prints the message instead of sending it.
 *
 * Without this, local development needs live 2Factor credentials: every
 * provider reports unhealthy, the factory returns "No SMS providers
 * available", and mobile verification and OTP sending cannot be exercised at
 * all.
 *
 * It is a real `SmsProvider` rather than a branch inside the factory, so the
 * local flow goes through the same health check, priority ordering, fallback
 * and delivery-report handling that production uses. (The pre-existing
 * `MOCK_SMS_SEND` flag short-circuits the factory entirely, which means it
 * skips exactly the logic most worth testing.)
 *
 * Priority 99 makes it the last resort: whenever a real provider is configured
 * and healthy, that provider is chosen and this one is never reached.
 */
@Injectable()
export class ConsoleProvider implements SmsProvider {
  private readonly logger = new Logger(ConsoleProvider.name);
  private readonly enabled: boolean;
  private readonly isProduction: boolean;

  constructor(private readonly config: ConfigService) {
    this.enabled = this.config.get<boolean>('sms.console.enabled') === true;
    this.isProduction = process.env.NODE_ENV === 'production';

    if (this.enabled && this.isProduction) {
      // Loud, once, at boot. The realistic way this ends up enabled in
      // production is a .env copied between environments, and the failure mode
      // is silent: OTPs "send" successfully and no customer ever receives one.
      this.logger.error(
        'SMS_CONSOLE_PROVIDER is enabled while NODE_ENV=production. ' +
          'Messages that fall through to this provider will be logged and ' +
          'NOT delivered to real recipients.',
      );
    } else if (this.enabled) {
      this.logger.warn(
        'Console SMS provider enabled — messages will be logged, not sent.',
      );
    }
  }

  get name(): string {
    return 'console';
  }

  get priority(): number {
    return 99;
  }

  isHealthy(): Promise<boolean> {
    return Promise.resolve(this.enabled);
  }

  sendSms(params: SendSmsParams): Promise<SendSmsResult> {
    const providerMsgId = `console_${randomUUID()}`;

    if (this.isProduction) {
      this.logger.error(
        `Console provider handled a real send to ${params.to} — NOT delivered.`,
      );
    }

    // Logged as one block so the code stays readable in a busy dev console.
    // The full content is printed deliberately: reading the OTP out of the log
    // is the entire point of this provider in local development.
    this.logger.log(
      [
        '',
        '┌─ SMS (console provider — not sent) ───────────────',
        `│ to        : ${params.to}`,
        `│ messageId : ${providerMsgId}`,
        `│ content   : ${params.content}`,
        ...(params.templateIdentifiers
          ? [`│ template  : ${JSON.stringify(params.templateIdentifiers)}`]
          : []),
        '└──────────────────────────────────────────────────',
      ].join('\n'),
    );

    return Promise.resolve({ providerMsgId, status: 'sent' });
  }

  /**
   * Reports delivered so the message reaches a terminal state locally.
   *
   * That matters: the deferred wallet debit only fires on the first transition
   * to DELIVERED, so returning anything else would leave local testing unable
   * to reach the billing path at all.
   */
  getDeliveryStatus(providerMsgId: string): Promise<DlrResult> {
    return Promise.resolve({
      status: 'delivered',
      description: 'Console provider — delivery simulated',
      deliveredAt: new Date(),
      senderId: 'CONSOLE',
      smsLanguage: 'english',
      characterCount: 0,
      smsCount: 1,
      providerCost: 0,
      rawResponse: { provider: 'console', providerMsgId },
    });
  }
}
