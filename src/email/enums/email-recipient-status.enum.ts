/**
 * Where one recipient of one campaign got to.
 *
 * Deliberately a single funnel column rather than a set of booleans: a
 * recipient is only ever at one point of the funnel, and a column ordered by
 * `FUNNEL_RANK` below can be advanced monotonically as webhooks arrive.
 *
 * Opens and clicks are *counted* separately (`openCount`, `clickCount`) because
 * those repeat; the status only records how far the recipient ever got.
 */
export enum EmailRecipientStatus {
  /** Materialised into the campaign, not yet handed to a worker. */
  PENDING = 'pending',
  /** A worker has claimed it — guards against double-send on retry. */
  SENDING = 'sending',
  /** Mailgun accepted the message. */
  SENT = 'sent',
  DELIVERED = 'delivered',
  OPENED = 'opened',
  CLICKED = 'clicked',
  /** Hard or soft bounce reported by Mailgun. */
  BOUNCED = 'bounced',
  /** Recipient hit "report spam". */
  COMPLAINED = 'complained',
  UNSUBSCRIBED = 'unsubscribed',
  /** We never tried: suppressed, or no usable address. */
  SKIPPED = 'skipped',
  /** We tried and the API call failed after retries. */
  FAILED = 'failed',
}

/**
 * How far along the funnel each status sits.
 *
 * Mailgun does not guarantee webhook ordering — an `opened` event routinely
 * arrives before the `delivered` event for the same message. Ranking lets the
 * writer move a recipient forward only, so a late-arriving `delivered` cannot
 * downgrade someone already recorded as having clicked.
 *
 * The terminal negatives (bounced/complained/unsubscribed) sit above the
 * positive funnel on purpose: they are the more important fact about that
 * address and must not be overwritten by a stray earlier event.
 */
export const FUNNEL_RANK: Record<EmailRecipientStatus, number> = {
  [EmailRecipientStatus.PENDING]: 0,
  [EmailRecipientStatus.SENDING]: 1,
  [EmailRecipientStatus.SENT]: 2,
  [EmailRecipientStatus.DELIVERED]: 3,
  [EmailRecipientStatus.OPENED]: 4,
  [EmailRecipientStatus.CLICKED]: 5,
  [EmailRecipientStatus.UNSUBSCRIBED]: 6,
  [EmailRecipientStatus.COMPLAINED]: 7,
  [EmailRecipientStatus.BOUNCED]: 8,
  // Set before any webhook can arrive, and never re-entered.
  [EmailRecipientStatus.SKIPPED]: 9,
  [EmailRecipientStatus.FAILED]: 9,
};
