import { Logger } from '@nestjs/common';
import nodemailer, { type Transporter } from 'nodemailer';
import type {
  MailTransport,
  OutboundMessage,
  SendOutcome,
} from './mail-transport.interface.js';

export interface SmtpTransportOptions {
  host: string;
  port: number;
  user: string;
  pass: string;
  secure: boolean;
  /** Ceiling the pool enforces itself, as a second line after the queue's. */
  maxPerSecond: number;
}

/**
 * Sends over any SMTP relay.
 *
 * This is the transport that makes "use something free" possible: Brevo, Zoho,
 * Mailjet, SES, a Google Workspace mailbox and a self-hosted server all speak
 * SMTP, so choosing between them becomes four environment variables rather than
 * a code change. Because opens, clicks and unsubscribes are tracked on our own
 * endpoints, a relay that reports nothing back still yields a complete
 * dashboard — everything except provider-confirmed delivery, which SMTP
 * genuinely cannot tell us.
 *
 * The connection is pooled and created lazily. A cold TCP + TLS + AUTH
 * handshake per message is several hundred milliseconds, and a relay that sees
 * one login per email starts treating the sender as a credential-stuffing
 * client.
 */
export class SmtpTransport implements MailTransport {
  readonly name = 'smtp';

  private readonly logger = new Logger(SmtpTransport.name);
  private transporter: Transporter | null = null;

  constructor(private readonly options: SmtpTransportOptions) {}

  get isConfigured(): boolean {
    return Boolean(
      this.options.host && this.options.user && this.options.pass,
    );
  }

  async send(message: OutboundMessage): Promise<SendOutcome> {
    if (!this.isConfigured) {
      throw new Error(
        'SMTP is not configured (CAMPAIGN_SMTP_HOST / _USER / _PASS).',
      );
    }

    const transporter = this.getTransporter();

    const info = await transporter.sendMail({
      from: { name: message.fromName, address: message.fromEmail },
      to: message.toName
        ? { name: message.toName, address: message.to }
        : message.to,
      replyTo: message.replyTo ?? undefined,
      subject: message.subject,
      html: message.html,
      text: message.text,
      headers: {
        // Both halves of RFC 8058. Gmail and Yahoo require one-click
        // unsubscribe from bulk senders; without it they throttle the sending
        // domain, and on a shared domain that would degrade OTP mail too.
        'List-Unsubscribe': `<${message.unsubscribeUrl}>`,
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
      },
    });

    // Nodemailer synthesises a Message-Id when the relay does not return one,
    // so this is generally present — but it is only ever used for support
    // lookups, never for attributing events.
    return { providerMessageId: info.messageId ?? null };
  }

  /** Closes the pool. Called on module shutdown so a deploy drains cleanly. */
  async close(): Promise<void> {
    this.transporter?.close();
    this.transporter = null;
    return Promise.resolve();
  }

  private getTransporter(): Transporter {
    if (this.transporter) return this.transporter;

    this.transporter = nodemailer.createTransport({
      host: this.options.host,
      port: this.options.port,
      // Implicit TLS on 465; 587 negotiates STARTTLS after connecting, which
      // is what `secure: false` means here — not "unencrypted".
      secure: this.options.secure,
      auth: { user: this.options.user, pass: this.options.pass },
      pool: true,
      maxConnections: 3,
      maxMessages: 100,
      rateLimit: this.options.maxPerSecond,
      rateDelta: 1000,
    });

    this.logger.log(
      `SMTP transport ready: ${this.options.host}:${this.options.port} ` +
        `(secure=${this.options.secure})`,
    );

    return this.transporter;
  }
}
