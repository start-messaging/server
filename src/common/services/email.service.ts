import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name);
  private readonly apiKey: string | undefined;
  private readonly domain: string | undefined;
  private readonly fromName: string;
  private readonly fromEmail: string;
  private readonly replyToEmail: string | undefined;

  private static readonly BASE_URL = 'https://api.mailgun.net/v3';

  constructor(private readonly config: ConfigService) {
    this.apiKey = this.config.get<string>('mailgun.apiKey');
    this.domain = this.config.get<string>('mailgun.domain');
    this.fromName =
      this.config.get<string>('mailgun.fromName') ?? 'StartMessaging';
    const configuredFromEmail = this.config.get<string>('mailgun.fromEmail');
    const configuredReplyToEmail = this.config.get<string>(
      'mailgun.replyToEmail',
    );
    const defaultFromEmail = this.buildDefaultFromEmail(this.domain);
    const isConfiguredFromAligned = this.isDomainAligned(
      configuredFromEmail,
      this.domain,
    );

    // Backward compatible fallback:
    // if MAILGUN_FROM_EMAIL is non-aligned (e.g. Gmail), force aligned From
    // and route replies to that configured email automatically.
    this.fromEmail = isConfiguredFromAligned
      ? configuredFromEmail
      : defaultFromEmail;
    this.replyToEmail =
      configuredReplyToEmail ||
      (!isConfiguredFromAligned ? configuredFromEmail : undefined);
  }

  async sendEmail(to: string, subject: string, html: string): Promise<boolean> {
    if (!this.apiKey || !this.domain) {
      this.logger.warn('Mailgun is not configured. Email not sent.');
      return false;
    }

    try {
      const url = `${EmailService.BASE_URL}/${this.domain}/messages`;
      const auth = Buffer.from(`api:${this.apiKey}`).toString('base64');

      const formData = new URLSearchParams();
      formData.append('from', `${this.fromName} <${this.fromEmail}>`);
      formData.append('to', to);
      formData.append('subject', subject);
      formData.append('html', html);
      formData.append('text', this.toText(html));
      if (this.replyToEmail) {
        formData.append('h:Reply-To', this.replyToEmail);
      }

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Basic ${auth}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: formData,
      });

      const data = await response.json();

      if (!response.ok) {
        this.logger.error(`Mailgun API error: ${JSON.stringify(data)}`);
        return false;
      }

      this.logger.log(`Email sent successfully to ${to}`);
      return true;
    } catch (err: any) {
      this.logger.error(`Failed to send email: ${err.message}`);
      return false;
    }
  }

  async sendKycSubmissionEmail(email: string, businessName: string) {
    const subject = 'KYC Submission Received';
    const html = this.wrapEmail({
      title: `Hi ${businessName}, your KYC is received`,
      body: `
        <p>We've received your KYC submission and started review.</p>
        <p>This usually completes within <strong>1-2 business days</strong>. We'll notify you once done.</p>
        ${this.kycAppLinksBlock()}
      `,
    });
    return this.sendEmail(email, subject, html);
  }

  async sendKycStatusUpdateEmail(
    email: string,
    businessName: string,
    status: string,
    reason?: string,
  ) {
    const isApproved = status === 'approved';
    const subject = isApproved
      ? 'KYC Approved - Welcome to StartMessaging'
      : 'KYC Update Required';

    const html = this.wrapEmail(
      isApproved
        ? {
            title: `Congratulations ${businessName}!`,
            body: `
              <p>Your KYC has been <strong>approved</strong>. You can now use the full messaging APIs.</p>
              <p>Sign in to open your dashboard, generate API keys, and start integration.</p>
              ${this.kycAppLinksBlock()}
            `,
          }
        : {
            title: 'KYC update required',
            body: `
              <p>Your KYC submission needs a few corrections before approval.</p>
              ${reason ? `<p><strong>Reason:</strong> ${reason}</p>` : ''}
              <p>Please sign in, update your details, and resubmit.</p>
              ${this.kycAppLinksBlock()}
            `,
          },
    );

    return this.sendEmail(email, subject, html);
  }

  async sendLowBalanceAlertEmail(
    email: string,
    displayName: string,
    balance: number,
    threshold: number,
  ) {
    const subject = `Low wallet balance alert (below ₹${threshold})`;
    const html = this.wrapEmail({
      title: `Hi ${displayName}, your wallet balance is low`,
      body: `
        <p>Your current wallet balance is <strong>₹${balance.toFixed(2)}</strong>.</p>
        <p>This has crossed below your alert threshold of <strong>₹${threshold}</strong>.</p>
        <p>Please add funds to avoid OTP delivery failures due to insufficient balance.</p>
      `,
    });
    return this.sendEmail(email, subject, html);
  }

  private buildDefaultFromEmail(domain?: string): string {
    if (!domain) return 'no-reply@example.invalid';
    return `no-reply@${domain}`;
  }

  private isDomainAligned(email?: string, domain?: string): email is string {
    if (!email || !domain) return false;
    return email.toLowerCase().endsWith(`@${domain.toLowerCase()}`);
  }

  private toText(html: string): string {
    return html
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/p>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  /**
   * Links shown in KYC-related emails (submission + status).
   *
   * Reads the same base URL the affiliate referral links use, rather than
   * hardcoding the production host: a non-production deployment that sends
   * mail would otherwise walk the recipient into production, where their
   * account does not exist. The default is unchanged, so production is
   * unaffected.
   */
  private kycAppLinksBlock(): string {
    const base = (
      this.config.get<string>('affiliate.referralBaseUrl') ??
      'https://app.startmessaging.com'
    ).replace(/\/$/, '');
    const signInUrl = `${base}/sign-in`;
    const dashboardUrl = `${base}/dashboard`;
    return `
      <div style="margin-top:24px;padding-top:20px;border-top:1px solid #e5e7eb;">
        <p style="margin:0 0 12px;font-size:14px;color:#374151;font-weight:600;">Go to your dashboard</p>
        <p style="margin:0 0 14px;">
          <a href="${signInUrl}" style="display:inline-block;background:#2563eb;color:#ffffff;text-decoration:none;padding:10px 18px;border-radius:8px;font-weight:600;font-size:14px;">Sign in</a>
        </p>
        <p style="margin:0;font-size:13px;color:#6b7280;line-height:1.5;">
          Direct links:<br/>
          <a href="${signInUrl}" style="color:#2563eb;">${signInUrl}</a><br/>
          <a href="${dashboardUrl}" style="color:#2563eb;">${dashboardUrl}</a> (after you sign in)
        </p>
      </div>
    `;
  }

  private wrapEmail({ title, body }: { title: string; body: string }): string {
    const brandLogoUrl = 'https://startmessaging.com/icon.svg';
    return `
      <div style="font-family:Arial,Helvetica,sans-serif;background:#f7f8fa;padding:24px;color:#111827;">
        <div style="max-width:640px;margin:0 auto;background:#ffffff;border:1px solid #e5e7eb;border-radius:12px;overflow:hidden;">
          <div style="padding:20px 24px;border-bottom:1px solid #e5e7eb;">
            <div style="display:flex;align-items:center;gap:12px;">
              <img src="${brandLogoUrl}" alt="${this.fromName}" width="36" height="36" style="display:block;border:0;" />
              <div style="font-size:18px;font-weight:700;">${this.fromName}</div>
            </div>
          </div>
          <div style="padding:24px;">
            <h2 style="margin:0 0 12px;font-size:20px;line-height:1.3;">${title}</h2>
            <div style="font-size:14px;line-height:1.6;color:#374151;">
              ${body}
            </div>
            <p style="margin-top:20px;font-size:14px;color:#374151;">Best regards,<br/>The ${this.fromName} Team</p>
          </div>
        </div>
      </div>
    `;
  }
}
