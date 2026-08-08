import { Logger } from '@nestjs/common';
import type {
  MailTransport,
  OutboundMessage,
  SendOutcome,
} from './mail-transport.interface.js';

export interface MailgunTransportOptions {
  apiKey: string | undefined;
  domain: string | undefined;
}

/**
 * Sends through Mailgun's HTTP API.
 *
 * Available because the deployment already holds Mailgun credentials for
 * transactional mail, so it is the one transport that needs no new account to
 * try. It is *not* the recommended default for outreach: Mailgun's acceptable
 * use policy forbids unsolicited email, and an enforcement action lands on the
 * account — which is the same account carrying KYC and low-balance mail. If
 * this transport is used, point it at a separate sending domain.
 *
 * Mailgun's own open/click tracking is deliberately switched off. Letting it
 * rewrite links would put its tracking domain in front of ours and produce a
 * second, disagreeing set of numbers; the pixel and redirect this codebase
 * serves are the single source of truth, and they work on every transport.
 */
export class MailgunTransport implements MailTransport {
  readonly name = 'mailgun';

  private readonly logger = new Logger(MailgunTransport.name);
  private static readonly BASE_URL = 'https://api.mailgun.net/v3';

  constructor(private readonly options: MailgunTransportOptions) {}

  get isConfigured(): boolean {
    return Boolean(this.options.apiKey && this.options.domain);
  }

  async send(message: OutboundMessage): Promise<SendOutcome> {
    const { apiKey, domain } = this.options;
    if (!apiKey || !domain) {
      throw new Error(
        'Mailgun is not configured (MAILGUN_API_KEY / MAILGUN_DOMAIN).',
      );
    }

    const form = new URLSearchParams();
    form.append('from', `${message.fromName} <${message.fromEmail}>`);
    form.append(
      'to',
      message.toName ? `${message.toName} <${message.to}>` : message.to,
    );
    form.append('subject', message.subject);
    form.append('html', message.html);
    form.append('text', message.text);
    if (message.replyTo) form.append('h:Reply-To', message.replyTo);

    form.append('h:List-Unsubscribe', `<${message.unsubscribeUrl}>`);
    form.append('h:List-Unsubscribe-Post', 'List-Unsubscribe=One-Click');

    // Ours wins; see the class comment.
    form.append('o:tracking-opens', 'no');
    form.append('o:tracking-clicks', 'no');

    form.append('v:campaign_id', message.campaignId);
    form.append('v:recipient_id', message.recipientId);

    const response = await fetch(
      `${MailgunTransport.BASE_URL}/${domain}/messages`,
      {
        method: 'POST',
        headers: {
          Authorization: `Basic ${Buffer.from(`api:${apiKey}`).toString('base64')}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: form,
      },
    );

    const payload = (await response.json().catch(() => ({}))) as {
      id?: string;
      message?: string;
    };

    if (!response.ok) {
      const detail = payload?.message ?? `HTTP ${response.status}`;
      this.logger.error(`Mailgun rejected message to ${message.to}: ${detail}`);
      throw new Error(detail);
    }

    return {
      providerMessageId: (payload.id ?? '').replace(/^<|>$/g, '') || null,
    };
  }
}
