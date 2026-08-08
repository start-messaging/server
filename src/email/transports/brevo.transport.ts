import { Logger } from '@nestjs/common';
import type {
  MailTransport,
  OutboundMessage,
  SendOutcome,
} from './mail-transport.interface.js';

/**
 * Sends through Brevo's HTTP send API.
 *
 * Offered alongside the SMTP transport, which can also reach Brevo, because
 * HTTP fails usefully where SMTP does not: a rejected message comes back as a
 * JSON error on the same request, whereas an SMTP relay accepts the message and
 * reports the problem hours later to a mailbox nobody reads. On a free tier
 * with a daily ceiling, knowing *immediately* that the quota is exhausted is
 * the difference between a paused campaign and a silently half-sent one.
 *
 * Deliberately written against `fetch` with no SDK, matching how the existing
 * Mailgun service talks to its provider.
 */
export class BrevoTransport implements MailTransport {
  readonly name = 'brevo';

  private readonly logger = new Logger(BrevoTransport.name);
  private static readonly ENDPOINT = 'https://api.brevo.com/v3/smtp/email';

  constructor(private readonly apiKey: string | undefined) {}

  get isConfigured(): boolean {
    return Boolean(this.apiKey);
  }

  async send(message: OutboundMessage): Promise<SendOutcome> {
    if (!this.apiKey) {
      throw new Error('Brevo is not configured (CAMPAIGN_BREVO_API_KEY).');
    }

    const response = await fetch(BrevoTransport.ENDPOINT, {
      method: 'POST',
      headers: {
        'api-key': this.apiKey,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        sender: { name: message.fromName, email: message.fromEmail },
        to: [
          message.toName
            ? { email: message.to, name: message.toName }
            : { email: message.to },
        ],
        replyTo: message.replyTo
          ? { email: message.replyTo }
          : undefined,
        subject: message.subject,
        htmlContent: message.html,
        textContent: message.text,
        headers: {
          'List-Unsubscribe': `<${message.unsubscribeUrl}>`,
          'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
        },
        // Echoed back on Brevo's own webhooks if they are ever enabled, and
        // visible in their dashboard for support questions.
        tags: [`campaign:${message.campaignId}`],
      }),
    });

    const payload = (await response.json().catch(() => ({}))) as {
      messageId?: string;
      message?: string;
      code?: string;
    };

    if (!response.ok) {
      const detail = payload?.message ?? `HTTP ${response.status}`;
      this.logger.error(`Brevo rejected message to ${message.to}: ${detail}`);
      // Surfacing the provider code lets the worker distinguish "over quota"
      // from a transient fault; the campaign service pauses on the former
      // rather than burning every remaining retry against a closed door.
      throw new Error(payload?.code ? `${payload.code}: ${detail}` : detail);
    }

    return {
      providerMessageId: (payload.messageId ?? '').replace(/^<|>$/g, '') || null,
    };
  }
}
