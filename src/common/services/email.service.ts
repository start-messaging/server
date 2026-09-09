import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  OnboardingBlockedStep,
  OnboardingReminderStage,
} from '../../onboarding/enums/onboarding-reminder.enum.js';
import { APP_NAME } from '../constants/app.constants.js';

/**
 * The mark shown at the top of every email.
 *
 * PNG, and deliberately not the SVG this used to point at. Gmail strips SVG
 * `<img>` sources outright — and the URL it used, `startmessaging.com/icon.svg`,
 * had been returning 404 besides, so the logo was a broken image in every KYC
 * and low-balance mail we have ever sent, not only the onboarding ones.
 *
 * Two things must stay true of whatever this points at: it is a raster format
 * (PNG, JPEG or GIF), and it is reachable without authentication by a stranger's
 * mail client. Anything served behind a login, or an SVG, renders as nothing.
 * WebP is not an option either — Gmail and Outlook both refuse it, which is why
 * this is the .png next to the .webp in the same bucket.
 *
 * Served from the `sm-public-assets` R2 bucket rather than an app's `public/`
 * folder, because an email is immortal: one sent today may be opened in three
 * years, and its images have to outlive every deploy and redesign in between.
 * That bucket holds nothing but brand assets — deliberately not the bucket KYC
 * documents go to, since a custom domain publishes a bucket in its entirety.
 */
const BRAND_LOGO_URL = 'https://cdn.startmessaging.com/logos/sm.png';

/**
 * Per-step wording for the onboarding reminder.
 *
 * Kept as data rather than a switch inside the template so the three variants
 * sit side by side and can be read as a set — the failure mode with prose
 * scattered through branches is two of them drifting apart in tone.
 */
const ONBOARDING_STEP_COPY: Record<
  OnboardingBlockedStep,
  {
    /** Subject for the 24-48 hour nudge. */
    subject: string;
    /**
     * The state of things, as a lower-case clause.
     *
     * Used twice on the final reminder — as the heading, and capitalised into
     * the subject — so the two cannot drift apart.
     */
    pending: string;
    /** Heading for the 24-48 hour nudge. */
    title: string;
    what: string;
    why: string;
  }
> = {
  [OnboardingBlockedStep.MOBILE_VERIFICATION]: {
    subject: 'Verify your mobile number to finish signing up',
    pending: 'your mobile number is still unverified',
    title: 'one step left — verify your mobile number',
    what: 'Verify your mobile number.',
    why: 'It takes about a minute. We send a one-time code to the number on your account, and once it is confirmed you can move on to your business details.',
  },
  [OnboardingBlockedStep.KYC_SUBMISSION]: {
    subject: 'Submit your business details to start sending',
    pending: 'your business details are still pending',
    title: 'one step left — submit your business details',
    what: 'Submit your KYC — business name, GSTIN or PAN, and address.',
    why: 'Indian telecom rules require verified business details before a sender can be approved. We review submissions within 1-2 business days.',
  },
  [OnboardingBlockedStep.KYC_RESUBMISSION]: {
    subject: 'Your KYC needs a correction',
    pending: 'your KYC still needs a correction',
    title: 'your KYC needs a small correction',
    what: 'Update your business details and resubmit them for review.',
    why: 'We could not approve the last submission. Sign in to see the reason we recorded against it, make the correction, and send it back — reviews take 1-2 business days.',
  },
};

/** Sentence-cases a clause that is otherwise written to sit mid-sentence. */
function leadingCapital(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

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
      this.config.get<string>('mailgun.fromName') ?? APP_NAME;
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
        ${this.appLinksBlock()}
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
              ${this.appLinksBlock()}
            `,
          }
        : {
            title: 'KYC update required',
            body: `
              <p>Your KYC submission needs a few corrections before approval.</p>
              ${reason ? `<p><strong>Reason:</strong> ${reason}</p>` : ''}
              <p>Please sign in, update your details, and resubmit.</p>
              ${this.appLinksBlock()}
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

  /**
   * The "you haven't finished signing up" nudge.
   *
   * Sent on the transactional Mailgun credentials rather than the campaign
   * transport, and that is deliberate. This is account-servicing mail to
   * somebody who created an account days ago and asked us for the service —
   * not outreach. Putting it on the campaign domain would spend that domain's
   * warmup budget, and putting it behind the campaign daily cap would silently
   * hold back reminders that are time-boxed to a 24-hour window.
   *
   * The copy names the one thing the customer still has to do. A generic
   * "complete your onboarding" makes the reader go and find out what is
   * missing, which is exactly the friction that stalled them the first time.
   */
  async sendOnboardingReminderEmail(
    email: string,
    displayName: string,
    stage: OnboardingReminderStage,
    step: OnboardingBlockedStep,
  ) {
    const isFinal = stage === OnboardingReminderStage.DAY_7;
    const action = ONBOARDING_STEP_COPY[step];

    const subject = isFinal
      ? `Still want to go live? ${leadingCapital(action.pending)}`
      : action.subject;

    const html = this.wrapEmail({
      // "One step left" is true on day two and grating on day seven, where the
      // reader has already had a week of it. The final note leads with the
      // state of the account instead.
      title: `Hi ${displayName}, ${isFinal ? action.pending : action.title}`,
      body: `
        <p>${
          isFinal
            ? 'Your StartMessaging account has been open for a week, but it still is not ready to send.'
            : 'Thanks for signing up to StartMessaging. Your account is almost ready.'
        }</p>
        <p><strong>${action.what}</strong></p>
        <p>${action.why}</p>
        ${
          isFinal
            ? '<p style="color:#6b7280;">This is the last reminder we will send about this. Your account stays open either way — pick it up whenever you are ready.</p>'
            : ''
        }
        ${this.appLinksBlock()}
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

  /**
   * The text/plain alternative that rides alongside the HTML.
   *
   * Anchors are rendered as "label (url)" rather than stripped to their label.
   * They used to be thrown away, which was survivable only because the body
   * also printed the URLs in visible text; now that the links are buttons,
   * dropping the href would leave a plain-text reader with a mail that names
   * an action and offers no way to take it. That reader is not hypothetical —
   * it is every client set to prefer plain text, and every screen reader that
   * follows that preference.
   */
  private toText(html: string): string {
    return (
      html
        // <head> first, and as a block. Stripping tags alone would leave the
        // stylesheet's rules behind as body text, so a plain-text reader would
        // open the mail to a screenful of CSS before reaching a word of it.
        .replace(/<head[\s\S]*?<\/head>/gi, '')
        .replace(/<style[\s\S]*?<\/style>/gi, '')
        .replace(/<!--[\s\S]*?-->/g, '')
        .replace(
          /<a\b[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi,
          (_match, href: string, label: string) => {
            const text = label.replace(/<[^>]+>/g, '').trim();
            return text ? `${text} (${href})` : href;
          },
        )
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/(p|tr|table|div|h[1-6])>/gi, '\n')
        .replace(/<\/td>/gi, ' ')
        .replace(/<[^>]+>/g, '')
        // Entities the templates actually emit; the spacer cells are &nbsp;.
        .replace(/&nbsp;/gi, ' ')
        .replace(/&amp;/gi, '&')
        .replace(/[ \t]{2,}/g, ' ')
        // Layout markup leaves whitespace-only lines behind. Trimming each
        // line before collapsing runs is what turns them into blank lines the
        // next rule can actually merge — without this the text arrives as a
        // long ladder of single spaces.
        .replace(/[ \t]*\n[ \t]*/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim()
    );
  }

  /**
   * Links shown at the foot of account emails (KYC, onboarding reminders).
   *
   * Reads the same base URL the affiliate referral links use, rather than
   * hardcoding the production host: a non-production deployment that sends
   * mail would otherwise walk the recipient into production, where their
   * account does not exist. The default is unchanged, so production is
   * unaffected.
   */
  private appLinksBlock(): string {
    const base = (
      this.config.get<string>('affiliate.referralBaseUrl') ??
      'https://app.startmessaging.com'
    ).replace(/\/$/, '');
    const signInUrl = `${base}/sign-in`;
    const dashboardUrl = `${base}/dashboard`;

    // Two buttons, and no bare URLs printed alongside them.
    //
    // The visible-URL block was how a reader reached the app without trusting
    // a link — but a URL written out in the body is a destination we can never
    // measure or change, because it is copied by hand into an address bar.
    // Every route to the app now goes through an anchor, which is the one
    // shape that can later be swapped for a redirect that records the click.
    //
    // Padding sits on the <td>, not the <a>: Outlook's Word engine ignores
    // padding on an inline-block, which collapses a styled anchor into bare
    // blue text. Colour on the <td> and the anchor filling it is the shape
    // that survives everywhere.
    //
    // Side by side on a wide screen, stacked full-width under 480px. The
    // stacking is done by the media query in wrapEmail, not here — the markup
    // is the desktop shape, and small screens override it.
    //
    // That direction matters. Outlook's desktop clients ignore media queries
    // entirely, so whatever is written inline is what they render; writing the
    // desktop layout inline means the one client that cannot adapt is also the
    // one that never needs to.
    //
    // Both cells are 170px so the pair is symmetrical — left to shrink-wrap,
    // "Sign in" comes out at roughly half the width of "Open dashboard" and
    // reads as an accident rather than a hierarchy.
    //
    // The filled button carries a border in its own background colour. It does
    // not show, but without it the outlined button sits one pixel narrower and
    // one pixel offset, and two buttons that disagree on their edges look
    // broken rather than deliberate.
    return `
      <div style="margin-top:24px;padding-top:20px;border-top:1px solid #e5e7eb;">
        <p style="margin:0 0 14px;font-size:14px;color:#374151;font-weight:600;">Go to your account</p>
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" class="btn-table">
          <tr>
            <td class="btn-cell" style="width:170px;border-radius:8px;background:#2563eb;border:1px solid #2563eb;">
              <a href="${signInUrl}" style="display:block;padding:10px 16px;font-family:Arial,Helvetica,sans-serif;font-size:14px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:8px;text-align:center;">Sign in</a>
            </td>
            <td class="btn-gap" style="width:12px;font-size:0;line-height:0;">&nbsp;</td>
            <td class="btn-cell" style="width:170px;border-radius:8px;background:#ffffff;border:1px solid #d1d5db;">
              <a href="${dashboardUrl}" style="display:block;padding:10px 16px;font-family:Arial,Helvetica,sans-serif;font-size:14px;font-weight:600;color:#374151;text-decoration:none;border-radius:8px;text-align:center;">Open dashboard</a>
            </td>
          </tr>
        </table>
      </div>
    `;
  }

  private wrapEmail({ title, body }: { title: string; body: string }): string {
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${this.fromName}</title>
<style>
  /*
   * The only responsive rule in the template, and the reason this is a whole
   * document rather than the fragment it used to be: a media query has to live
   * in a <head>, and there was not one to put it in.
   *
   * Under 480px the two call-to-action buttons stop sharing a row and become
   * full-width blocks, because 170px each plus a gutter does not fit a phone
   * without the labels wrapping mid-word. Everything is !important: it is
   * overriding inline styles, which otherwise win.
   *
   * Clients that ignore this — Outlook's desktop builds — keep the inline
   * desktop layout, which is the correct one for a desktop window anyway.
   */
  @media only screen and (max-width: 480px) {
    .btn-table { width: 100% !important; }
    .btn-cell  { display: block !important; width: 100% !important; }
    /* Becomes the vertical gutter once the cells are stacked. */
    .btn-gap   { display: block !important; width: 100% !important; height: 10px !important; }
  }
</style>
</head>
<body style="margin:0;padding:0;">
      <div style="font-family:Arial,Helvetica,sans-serif;background:#f7f8fa;padding:24px;color:#111827;">
        <div style="max-width:640px;margin:0 auto;background:#ffffff;border:1px solid #e5e7eb;border-radius:12px;overflow:hidden;">
          <div style="padding:20px 24px;border-bottom:1px solid #e5e7eb;">
            <!--
              A table, not a flex row. Flexbox is unsupported by Outlook's Word
              rendering engine, which drops it and stacks the mark above the
              wordmark. A two-cell table is the one layout every client agrees
              on, and it is why email markup still looks like this.
            -->
            <table role="presentation" cellpadding="0" cellspacing="0" border="0">
              <tr>
                <td style="padding-right:12px;vertical-align:middle;">
                  <img src="${BRAND_LOGO_URL}" alt="${this.fromName}" width="36" height="36" style="display:block;border:0;width:36px;height:36px;" />
                </td>
                <td style="vertical-align:middle;font-size:18px;font-weight:700;color:#111827;">${this.fromName}</td>
              </tr>
            </table>
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
</body>
</html>`;
  }
}
