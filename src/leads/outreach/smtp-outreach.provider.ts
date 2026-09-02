import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import nodemailer, { Transporter } from 'nodemailer';
import {
  OutreachMessage,
  OutreachProvider,
} from './outreach-provider.interface.js';
import { APP_NAME } from '../../common/constants/app.constants.js';

/**
 * SMTP transport for cold outreach.
 *
 * Deliberately does NOT reuse the Mailgun transactional credentials: cold
 * mail on the product domain risks the account every password-reset depends
 * on — every mainstream ESP's AUP prohibits unsolicited outreach, and one
 * complaint-rate spike suspends the whole account, not just the campaign.
 * This transport points at a separate lookalike domain's inbox, whose worst
 * outcome is losing a domain nothing transactional depends on.
 */
@Injectable()
export class SmtpOutreachProvider implements OutreachProvider {
  readonly name = 'smtp';

  private transporter: Transporter | null = null;

  constructor(private readonly config: ConfigService) {}

  /**
   * Built lazily: the provider is registered unconditionally, and reading the
   * config at construction would open a connection pool in every deployment,
   * configured or not.
   */
  private getTransporter(): Transporter {
    if (!this.transporter) {
      this.transporter = nodemailer.createTransport({
        host: this.config.get<string>('outreach.smtp.host'),
        port: this.config.get<number>('outreach.smtp.port') ?? 587,
        secure: this.config.get<boolean>('outreach.smtp.secure') === true,
        auth: {
          user: this.config.get<string>('outreach.smtp.user'),
          pass: this.config.get<string>('outreach.smtp.pass'),
        },
      });
    }
    return this.transporter;
  }

  async send(msg: OutreachMessage): Promise<{ ref: string }> {
    const fromName =
      this.config.get<string>('outreach.fromName') ?? APP_NAME;
    const fromEmail = this.config.get<string>('outreach.fromEmail');
    const replyTo = this.config.get<string>('outreach.replyTo');

    const info = await this.getTransporter().sendMail({
      from: `"${fromName}" <${fromEmail}>`,
      to: msg.to,
      subject: msg.subject,
      html: msg.html,
      text: msg.text,
      ...(replyTo ? { replyTo } : {}),
      headers: msg.headers,
    });

    return { ref: info.messageId ?? 'smtp' };
  }
}
