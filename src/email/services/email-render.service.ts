import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/** The person a campaign is being rendered for. */
export interface MergeContext {
  email: string;
  firstName?: string | null;
  lastName?: string | null;
  companyName?: string | null;
}

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

/** A merge field the composer offers, and what it resolves to. */
export const MERGE_FIELDS = [
  { token: 'firstName', label: 'First name', sample: 'Ravi' },
  { token: 'lastName', label: 'Last name', sample: 'Sharma' },
  { token: 'fullName', label: 'Full name', sample: 'Ravi Sharma' },
  { token: 'email', label: 'Email address', sample: 'ravi@acme.in' },
  { token: 'companyName', label: 'Company', sample: 'Acme Technologies' },
] as const;

/**
 * Turns a stored campaign into the exact bytes one recipient receives.
 *
 * Kept free of database and provider concerns so the composer's live preview
 * and the send worker can call the same code. A preview that renders through a
 * different path than the send is a preview that lies, and the whole point of
 * the preview is to be trusted before mailing a few thousand people.
 */
@Injectable()
export class EmailRenderService {
  private readonly brandName: string;
  private readonly companyAddress: string;

  constructor(private readonly config: ConfigService) {
    this.brandName =
      this.config.get<string>('campaigns.fromName') ?? 'StartMessaging';
    this.companyAddress =
      this.config.get<string>('campaigns.companyAddress') ?? '';
  }

  /**
   * Substitutes merge fields.
   *
   * `{{firstName}}` takes the value; `{{firstName|there}}` falls back to
   * "there" when it is missing. The fallback form exists because the failure it
   * prevents is the single most visible one in cold outreach — "Hi ," at the
   * top of an email announces that it was blasted, and half the recipients of
   * a pasted lead list have no name attached.
   */
  substitute(
    template: string,
    ctx: MergeContext,
    opts: { escape: boolean },
  ): string {
    const values = this.resolveValues(ctx);

    return template.replace(
      /\{\{\s*(\w+)\s*(?:\|([^}]*))?\}\}/g,
      (_match, token: string, fallback?: string) => {
        const raw = values[token];
        const value =
          raw !== undefined && raw !== null && raw !== ''
            ? raw
            : (fallback ?? '').trim();
        return opts.escape ? this.escapeHtml(value) : value;
      },
    );
  }

  /**
   * Renders a campaign for one recipient.
   *
   * `bodyHtml` is escaped on substitution but not itself sanitised: it is
   * composer output written by a signed-in admin, and stripping tags would
   * destroy the formatting they just applied. The *values* are escaped because
   * those come from customer-supplied names and pasted lead lists.
   */
  render(
    campaign: {
      subject: string;
      bodyHtml: string;
      preheader?: string | null;
    },
    ctx: MergeContext,
    unsubscribeUrl: string,
  ): RenderedEmail {
    // Newlines stripped from the subject before anything else: a value carrying
    // CRLF into a mail header is header injection, and merge values reach this
    // from pasted lead lists that nobody has reviewed.
    const subject = this.substitute(campaign.subject, ctx, { escape: false })
      .replace(/[\r\n]+/g, ' ')
      .trim();

    const body = this.substitute(campaign.bodyHtml, ctx, { escape: true });
    const preheader = campaign.preheader
      ? this.substitute(campaign.preheader, ctx, { escape: true })
      : null;

    const html = this.wrap({ body, preheader, unsubscribeUrl });

    return { subject, html, text: this.toPlainText(body, unsubscribeUrl) };
  }

  /**
   * Wraps composer output in the sending shell.
   *
   * Table-based and inline-styled on purpose. Outlook renders through Word's
   * HTML engine, which supports neither flexbox nor grid and drops most of a
   * <style> block — layout that looks fine in a browser preview collapses into
   * a single unstyled column there.
   */
  private wrap({
    body,
    preheader,
    unsubscribeUrl,
  }: {
    body: string;
    preheader: string | null;
    unsubscribeUrl: string;
  }): string {
    // Hidden preview text, followed by enough zero-width space to stop the
    // client pulling the body's first words in after it.
    const preheaderBlock = preheader
      ? `<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;font-size:1px;line-height:1px;color:#ffffff;">${preheader}${'&#8203;'.repeat(60)}</div>`
      : '';

    // A postal address is a CAN-SPAM requirement for commercial mail and a
    // strong trust signal for spam filters. Rendered only when configured, so
    // an unset value leaves no empty box behind.
    const addressBlock = this.companyAddress
      ? `<div style="margin-top:8px;">${this.escapeHtml(this.companyAddress)}</div>`
      : '';

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="x-apple-disable-message-reformatting" />
<title>${this.escapeHtml(this.brandName)}</title>
</head>
<body style="margin:0;padding:0;background:#f5f6f8;">
${preheaderBlock}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f5f6f8;">
  <tr>
    <td align="center" style="padding:24px 12px;">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;background:#ffffff;border:1px solid #e5e7eb;border-radius:12px;">
        <tr>
          <td style="padding:28px 32px 8px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;font-size:15px;line-height:1.65;color:#1f2937;">
${body}
          </td>
        </tr>
        <tr>
          <td style="padding:20px 32px 28px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;font-size:12px;line-height:1.6;color:#9ca3af;border-top:1px solid #f0f1f3;">
            <div>You received this because you are on ${this.escapeHtml(this.brandName)}'s contact list.</div>
            <div style="margin-top:6px;">
              <a href="${unsubscribeUrl}" style="color:#6b7280;text-decoration:underline;">Unsubscribe</a>
            </div>
            ${addressBlock}
          </td>
        </tr>
      </table>
    </td>
  </tr>
</table>
</body>
</html>`;
  }

  /**
   * Derives the plain-text alternative.
   *
   * Not optional. A multipart message with no text part scores measurably worse
   * with spam filters, and text-only clients would otherwise show nothing at
   * all. Links are flattened to "label (url)" rather than dropped, so the
   * text part carries the same call to action.
   */
  toPlainText(html: string, unsubscribeUrl?: string): string {
    const text = html
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(
        /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi,
        (_m, href: string, label: string) => {
          const clean = label.replace(/<[^>]+>/g, '').trim();
          // A bare URL used as its own label would otherwise print twice.
          return clean && clean !== href ? `${clean} (${href})` : href;
        },
      )
      .replace(/<(?:br|\/p|\/div|\/h[1-6]|\/li)\s*\/?>/gi, '\n')
      .replace(/<li\b[^>]*>/gi, '- ')
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&#8203;/g, '')
      .replace(/&amp;/gi, '&')
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/&quot;/gi, '"')
      .replace(/&#39;/gi, "'")
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();

    return unsubscribeUrl
      ? `${text}\n\n—\nUnsubscribe: ${unsubscribeUrl}`
      : text;
  }

  /** Sample context for the composer's preview when no recipient is selected. */
  sampleContext(): MergeContext {
    return {
      email: 'ravi@acme.in',
      firstName: 'Ravi',
      lastName: 'Sharma',
      companyName: 'Acme Technologies',
    };
  }

  private resolveValues(ctx: MergeContext): Record<string, string> {
    const first = (ctx.firstName ?? '').trim();
    const last = (ctx.lastName ?? '').trim();
    return {
      firstName: first,
      lastName: last,
      fullName: [first, last].filter(Boolean).join(' '),
      email: ctx.email ?? '',
      companyName: (ctx.companyName ?? '').trim(),
    };
  }

  private escapeHtml(value: string): string {
    return value
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }
}
