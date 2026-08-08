/** One message, already rendered and instrumented, ready to hand to a relay. */
export interface OutboundMessage {
  to: string;
  /** Display name of the recipient, for the RFC 5322 `To:` phrase. */
  toName?: string | null;
  subject: string;
  html: string;
  text: string;
  fromName: string;
  fromEmail: string;
  replyTo?: string | null;
  /** Absolute URL for RFC 8058 one-click unsubscribe. */
  unsubscribeUrl: string;
  /**
   * Opaque correlation ids. A transport that has webhooks should attach these
   * so its callbacks can be attributed; one that does not may ignore them.
   */
  campaignId: string;
  recipientId: string;
}

export interface SendOutcome {
  /**
   * The relay's own id for this message, when it gives one.
   *
   * Null is normal, not an error — a plain SMTP relay returns only a queue
   * acknowledgement. Nothing downstream may depend on this being present,
   * which is why delivery state is driven by our own tracking rather than by
   * provider ids.
   */
  providerMessageId: string | null;
}

/**
 * A way to get one email onto the internet.
 *
 * Intentionally the narrowest possible surface. Open and click tracking,
 * unsubscribe handling, retries, rate limiting and analytics all live above
 * this line, so switching provider — or dropping to a personal mailbox over
 * SMTP — costs one class and no change to the campaign logic or the dashboard.
 *
 * Implementations MUST throw on failure rather than returning a falsy result:
 * the caller is a BullMQ worker whose retry and backoff only engage on a
 * thrown error.
 */
export interface MailTransport {
  /** Name shown in the admin panel's diagnostics. */
  readonly name: string;

  /** False when credentials are missing; the panel blocks sending on this. */
  readonly isConfigured: boolean;

  send(message: OutboundMessage): Promise<SendOutcome>;
}

/** DI token — `MailTransport` is an interface and erases at runtime. */
export const MAIL_TRANSPORT = Symbol('MAIL_TRANSPORT');
