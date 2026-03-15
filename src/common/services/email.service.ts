import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name);
  private readonly apiKey: string | undefined;
  private readonly domain: string | undefined;
  private readonly fromName: string;
  private readonly fromEmail: string;

  private static readonly BASE_URL = 'https://api.mailgun.net/v3';

  constructor(private readonly config: ConfigService) {
    this.apiKey = this.config.get<string>('mailgun.apiKey');
    this.domain = this.config.get<string>('mailgun.domain');
    this.fromName = this.config.get<string>('mailgun.fromName') ?? 'StartMessaging';
    this.fromEmail = this.config.get<string>('mailgun.fromEmail') ?? `no-reply@${this.domain}`;
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
    const html = `
      <h1>Hello ${businessName},</h1>
      <p>We've received your KYC submission. Our team will review it within 1-2 business days.</p>
      <p>We'll notify you once the review is complete.</p>
      <br/>
      <p>Best regards,</p>
      <p>The ${this.fromName} Team</p>
    `;
    return this.sendEmail(email, subject, html);
  }

  async sendKycStatusUpdateEmail(email: string, businessName: string, status: string, reason?: string) {
    const isApproved = status === 'approved';
    const subject = isApproved ? 'KYC Approved - Welcome to StartMessaging' : 'KYC Update Required';
    
    const html = isApproved 
      ? `<h1>Congratulations ${businessName}!</h1>
         <p>Your KYC has been approved. You can now start using our full set of messaging APIs.</p>
         <p>Log in to your dashboard to get your API keys.</p>`
      : `<h1>Important Update Regarding Your KYC</h1>
         <p>Your KYC submission requires changes.</p>
         ${reason ? `<p><strong>Reason:</strong> ${reason}</p>` : ''}
         <p>Please log in to your dashboard to update your details and resubmit.</p>`;

    return this.sendEmail(email, subject, html + `<br/><p>Best regards,</p><p>The ${this.fromName} Team</p>`);
  }
}
