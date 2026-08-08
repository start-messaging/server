/**
 * Shared 2Factor status vocabulary.
 *
 * 2Factor reports the fate of a message through two channels that do not use
 * the same wording: the DLR webhook (SessionId + Status + Error) and the
 * transactional report API (statusDesc + errorId). Both are decoded here so
 * the two paths cannot drift apart — before this existed only the webhook
 * could interpret an error code, which is part of why a message that never
 * produced a webhook stayed `sent` forever.
 */

export const BARRED_REASON =
  'Message delivery failed due to message service barring on the recipient number. In many cases, this occurs when the recipient does not maintain sufficient balance, resulting in the suspension of incoming services on the number.';

/** Terminal outcome, provider-agnostic. `unknown` means "ask again later". */
export type TwoFactorOutcome = 'delivered' | 'failed' | 'sent' | 'unknown';

/**
 * What a customer is told when the provider's own wording is not safe to
 * repeat. Provider vocabulary (`REJECTD`, `FAILED(BARRED)`, `Invalid API Key`,
 * operator and DLT strings) names the provider, or exposes our credential
 * state, so none of it is passed through.
 */
export const GENERIC_FAILURE_REASON =
  'The message could not be delivered to this number. Please check the number and try again, or contact support if it continues.';

/**
 * Customer-safe explanation for a failure.
 *
 * A whitelist, not a filter: only the curated reasons in TWO_FACTOR_ERROR_MAP
 * are ever shown. Anything unrecognised — including any future provider
 * wording nobody has reviewed — collapses to the generic sentence. The raw
 * text is kept separately on `providerFailureReason` for admins.
 */
export function customerFacingReason(errorCode: string): string {
  return TWO_FACTOR_ERROR_MAP[errorCode]?.reason ?? GENERIC_FAILURE_REASON;
}

/**
 * Error codes are zero-padded to three characters before lookup, because the
 * webhook sends `13` where the report API sends `013` for the same condition.
 */
export function normalizeErrorCode(error: unknown): string {
  if (error === null || error === undefined || error === '') return '';
  if (typeof error !== 'string' && typeof error !== 'number') return '';
  return String(error).padStart(3, '0');
}

export const TWO_FACTOR_ERROR_MAP: Record<
  string,
  { outcome: TwoFactorOutcome; reason: string }
> = {
  '000': { outcome: 'delivered', reason: 'Delivered' },
  '021': {
    outcome: 'failed',
    reason:
      'Facility not supported by network. This might be due to insufficient balance or message service facility being unavailable for this number.',
  },
  '013': { outcome: 'failed', reason: BARRED_REASON },
  '011': { outcome: 'failed', reason: BARRED_REASON },
  '151': { outcome: 'failed', reason: BARRED_REASON },
  '154': { outcome: 'failed', reason: BARRED_REASON },
  '109': {
    outcome: 'failed',
    reason: 'Invalid or incorrectly formatted recipient number.',
  },
  '180': {
    outcome: 'failed',
    reason:
      'Destination telecom network was temporarily unreachable. Please retry after some time.',
  },
  '027': {
    outcome: 'failed',
    reason: 'Recipient is unreachable (switched off or out of coverage area).',
  },
  '033': {
    outcome: 'failed',
    reason:
      "Message delivery failed as the recipient's network message queue is full.",
  },
  '088': {
    outcome: 'failed',
    reason: 'Network timeout while fetching recipient details. Please retry.',
  },
  '032': {
    outcome: 'failed',
    reason: "Recipient's phone memory is full. Message could not be delivered.",
  },
  '005': {
    outcome: 'failed',
    reason:
      'Unidentified subscriber. The recipient number is not allocated or active.',
  },
  '633': {
    outcome: 'failed',
    reason:
      'Message rejected by the operator, usually because the sender header or template is not approved on DLT for this content.',
  },
  '1': {
    outcome: 'failed',
    reason: 'General network failure or recipient did not answer.',
  },
};

/**
 * Decodes a status *name* — `DELIVERED`, `REJECTD`, `FAILED(BARRED)`, and the
 * webhook's own spellings. Used when no error code matched.
 *
 * An unrecognised value maps to `sent`, never to `failed`: a message whose
 * fate we cannot read is still in flight, and calling it failed would both
 * mislead the customer and permanently skip the delivery debit.
 */
export function mapTwoFactorStatusName(status: string): TwoFactorOutcome {
  const s = (status || '').toUpperCase();
  if (s.includes('DELIVERED')) return 'delivered';
  if (
    s.includes('FAILED') ||
    s.includes('REJECTD') ||
    s.includes('REJECTED') ||
    s.includes('UNDELIVERED') ||
    s.includes('UNDELIV') ||
    s.includes('BARRED') ||
    s.includes('EXPIRED') ||
    s.includes('NO-ANSWER') ||
    s.includes('ERROR')
  )
    return 'failed';
  return 'sent';
}

/**
 * 2Factor stamps its reports in IST with no offset in the string
 * (`2026-08-07 15:45:55`). Verified against production: three sampled reports
 * sat exactly 5h30m ahead of our own UTC `createdAt` for the same message.
 * Parsing them as server-local time would place every delivery 5.5 hours in
 * the future on a UTC host.
 */
export function parseIstTimestamp(raw: string | null): Date | null {
  if (!raw) return null;
  const m = raw
    .trim()
    .match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/);
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m;
  const asUtc = Date.UTC(+y, +mo - 1, +d, +h, +mi, +s);
  const date = new Date(asUtc - 5.5 * 60 * 60 * 1000);
  return Number.isNaN(date.getTime()) ? null : date;
}
