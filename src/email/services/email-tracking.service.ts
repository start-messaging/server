import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'node:crypto';

/** What a click token carries once verified. */
export interface ClickTokenPayload {
  recipientId: string;
  url: string;
}

/**
 * Builds and verifies the tracking links embedded in campaign email.
 *
 * Every link points back at this server rather than at the mail provider, which
 * is the whole reason the analytics survive a change of provider — and the
 * reason they work at all on a plain SMTP relay or a personal mailbox, neither
 * of which reports anything back.
 *
 * Tokens are HMACs rather than raw ids. These URLs travel through the open
 * internet inside mail that is forwarded, archived and scraped, so an
 * unauthenticated endpoint that took a bare recipient id would let anyone
 * enumerate the recipient table by counting up, and — far worse — unsubscribe
 * arbitrary people.
 */
@Injectable()
export class EmailTrackingService {
  private readonly logger = new Logger(EmailTrackingService.name);
  private readonly baseUrl: string;
  private readonly secret: string;

  /**
   * Domain separation for the three link types.
   *
   * Without a distinct prefix per purpose, one signature would be valid for all
   * three endpoints — so the pixel URL sitting in every delivered email, which
   * any mail client fetches automatically, would double as a working
   * unsubscribe link for that recipient.
   */
  private static readonly PURPOSE_OPEN = 'o';
  private static readonly PURPOSE_CLICK = 'c';
  private static readonly PURPOSE_UNSUBSCRIBE = 'u';

  /** 160 bits of a SHA-256 tag. Far past forgery, and keeps links short. */
  private static readonly SIG_LENGTH = 27;

  /** A 1x1 transparent GIF. Smaller than the equivalent PNG, and universal. */
  static readonly PIXEL_GIF = Buffer.from(
    'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
    'base64',
  );

  constructor(private readonly config: ConfigService) {
    this.baseUrl = (
      this.config.get<string>('campaigns.trackingBaseUrl') ??
      'http://localhost:3000'
    ).replace(/\/$/, '');
    this.secret = this.config.get<string>('campaigns.trackingSecret') ?? '';
  }

  get isConfigured(): boolean {
    return Boolean(this.secret);
  }

  // ── Link builders ────────────────────────────────────

  /**
   * The open pixel carries the recipient id inside a single path segment,
   * because its route matches one `:token`. Click and unsubscribe take the id
   * as its own segment and so append only the signature — repeating the id in
   * both places would make the signature check compare against the wrong
   * string and reject every genuine request.
   */
  openPixelUrl(recipientId: string): string {
    const sig = this.sign(EmailTrackingService.PURPOSE_OPEN, recipientId);
    // The `.gif` suffix is cosmetic but load-bearing: a few clients and proxies
    // decline to render an <img> whose URL has no image-like extension.
    return `${this.baseUrl}/e/o/${recipientId}.${sig}.gif`;
  }

  clickUrl(recipientId: string, targetUrl: string): string {
    const encoded = this.b64url(Buffer.from(targetUrl, 'utf8'));
    const sig = this.sign(
      EmailTrackingService.PURPOSE_CLICK,
      `${recipientId}:${targetUrl}`,
    );
    return `${this.baseUrl}/e/c/${recipientId}/${encoded}/${sig}`;
  }

  unsubscribeUrl(recipientId: string): string {
    const sig = this.sign(
      EmailTrackingService.PURPOSE_UNSUBSCRIBE,
      recipientId,
    );
    return `${this.baseUrl}/e/u/${recipientId}/${sig}`;
  }

  // ── Verifiers ────────────────────────────────────────

  /** Returns the recipient id, or null if the token is not ours. */
  verifyOpen(tokenWithSuffix: string): string | null {
    const token = tokenWithSuffix.replace(/\.gif$/i, '');
    const dot = token.lastIndexOf('.');
    if (dot < 1) return null;
    const recipientId = token.slice(0, dot);
    const sig = token.slice(dot + 1);
    return this.check(EmailTrackingService.PURPOSE_OPEN, recipientId, sig)
      ? recipientId
      : null;
  }

  verifyClick(
    recipientId: string,
    encodedUrl: string,
    sig: string,
  ): ClickTokenPayload | null {
    let url: string;
    try {
      url = Buffer.from(this.unb64url(encodedUrl), 'base64').toString('utf8');
    } catch {
      return null;
    }

    // The signature covers the destination as well as the recipient. Signing
    // only the recipient would leave an open redirect on a domain that sends
    // our own mail — an ideal host for a phishing link.
    if (
      !this.check(
        EmailTrackingService.PURPOSE_CLICK,
        `${recipientId}:${url}`,
        sig,
      )
    ) {
      return null;
    }

    // Belt and braces: even correctly signed, only ever redirect somewhere a
    // browser would treat as a web page.
    if (!/^https?:\/\//i.test(url)) return null;

    return { recipientId, url };
  }

  verifyUnsubscribe(recipientId: string, sig: string): string | null {
    return this.check(
      EmailTrackingService.PURPOSE_UNSUBSCRIBE,
      recipientId,
      sig,
    )
      ? recipientId
      : null;
  }

  // ── HTML instrumentation ─────────────────────────────

  /**
   * Rewrites outbound links through the click endpoint and appends the open
   * pixel.
   *
   * Runs per recipient rather than once per campaign, because each token is
   * bound to one person — that binding is what turns "someone opened it" into
   * "this account opened it", which is the entire point of the feature for
   * outreach.
   */
  instrumentHtml(
    html: string,
    recipientId: string,
    opts: { trackOpens: boolean; trackClicks: boolean },
  ): string {
    let output = html;

    if (opts.trackClicks) {
      output = output.replace(
        /(<a\b[^>]*\bhref=)(["'])(.*?)\2/gi,
        (match, prefix: string, quote: string, href: string) => {
          if (!this.isTrackableLink(href)) return match;
          return `${prefix}${quote}${this.clickUrl(recipientId, href)}${quote}`;
        },
      );
    }

    if (opts.trackOpens) {
      const pixel =
        `<img src="${this.openPixelUrl(recipientId)}" width="1" height="1" ` +
        `alt="" style="display:block;width:1px;height:1px;border:0;overflow:hidden;" />`;
      // Immediately before </body> when there is one — some clients discard
      // markup that trails the closing tag, which would silently zero the
      // open rate for those recipients.
      output = /<\/body>/i.test(output)
        ? output.replace(/<\/body>/i, `${pixel}</body>`)
        : output + pixel;
    }

    return output;
  }

  /**
   * Whether a href should be rewritten.
   *
   * Anything already pointing at our own tracking origin is left alone so a
   * re-render cannot nest a token inside a token, and the unsubscribe link in
   * particular must reach the real endpoint rather than be recorded as a
   * click — someone leaving is not engagement.
   */
  private isTrackableLink(href: string): boolean {
    const value = href.trim();
    if (!value) return false;
    if (/^(mailto:|tel:|sms:|#)/i.test(value)) return false;
    if (!/^https?:\/\//i.test(value)) return false;
    if (value.startsWith(`${this.baseUrl}/e/`)) return false;
    // Merge-field placeholders are substituted before this runs; one surviving
    // here means the link is not a real URL yet.
    if (value.includes('{{')) return false;
    return true;
  }

  // ── Signing primitives ───────────────────────────────

  private sign(purpose: string, payload: string): string {
    return this.b64url(
      createHmac('sha256', this.secret).update(`${purpose}:${payload}`).digest(),
    ).slice(0, EmailTrackingService.SIG_LENGTH);
  }

  private check(purpose: string, payload: string, provided: string): boolean {
    if (!this.secret) {
      this.logger.warn('CAMPAIGN_TRACKING_SECRET is unset; rejecting token.');
      return false;
    }
    const expected = this.sign(purpose, payload);
    const a = Buffer.from(expected);
    const b = Buffer.from(provided ?? '');
    // timingSafeEqual throws on a length mismatch, so the cheap check has to
    // come first — and a wrong length is already a decisive rejection.
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  }

  private b64url(buf: Buffer): string {
    return buf
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
  }

  private unb64url(value: string): string {
    return value.replace(/-/g, '+').replace(/_/g, '/');
  }
}
