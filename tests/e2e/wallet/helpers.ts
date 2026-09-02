import { APIRequestContext, APIResponse } from '@playwright/test';
import { createHmac } from 'crypto';
import { sql } from '../helpers/db.js';
import { auth, seedDeliveredMessage } from '../helpers/actors.js';
import { seedLedger } from '../helpers/wallet.js';

// Re-exported so the specs in this directory keep importing their fixtures
// from one place; the implementation is shared with every other suite.
export { seedLedger } from '../helpers/wallet.js';
export type { LedgerEntry } from '../helpers/wallet.js';

/**
 * Shared fixtures for the customer wallet surface — `GET /wallet` and
 * `GET /wallet/transactions` — and the service underneath them.
 *
 * The controller is two lines long; everything worth testing is below it, and
 * every spec in this directory reaches it through the seeding and reading
 * helpers collected here rather than writing the balance column by hand.
 *
 * wallet/otp-billing covers the shape of the feature and
 * messages/delivery-status covers the status-check route itself. Nothing here
 * repeats either: no happy-path read, no per-message billing.
 *
 * Money is asserted exactly. Every figure these fixtures produce is a whole
 * number of paise and comes back out of `numeric(12,4)`, so `toBeCloseTo`
 * would only hide the defect it is meant to catch.
 */

/** A well-formed uuid that no row will ever have. */
export const ABSENT_UUID = '00000000-0000-4000-8000-00000000dead';

/** What registration credits a new account, and therefore every opening balance. */
export const WELCOME_CREDIT = 10;

/**
 * The per-message cost these fixtures seed, and therefore the amount one
 * delivered message debits.
 *
 * The debit is `message.costAmount`, not a runtime lookup of OTP_COST — the
 * tariff is stamped onto the row at send time — so this is the value written
 * into the seeded messages rather than a reading of the environment. It
 * matches OTP_COST in .env.e2e only so the figures here look like real ones.
 */
export const OTP_COST = 0.25;

export interface TxRow {
  id: string;
  walletId: string;
  type: string;
  amount: string;
  balanceBefore: string;
  balanceAfter: string;
  referenceType: string | null;
  /**
   * Declared because `ledgerOf` selects `t.*` and this is the column the money
   * invariant turns on: at most one otp_usage debit per message id.
   */
  referenceId: string | null;
  description: string;
  createdAt: string;
}

export interface WalletRow {
  id: string;
  userId: string;
  balance: number;
  currency: string;
  version: number;
}

/** Unwraps the `{ code, message }` half of the error envelope. */
export async function errorOf(
  res: APIResponse,
): Promise<{ code: string; message: string }> {
  const body = (await res.json()) as {
    error?: { code: string; message: string };
  };
  if (!body.error) {
    throw new Error(
      `expected an error envelope, got ${JSON.stringify(body).slice(0, 300)}`,
    );
  }
  return body.error;
}

/**
 * The pagination block, which the interceptor lifts out of the handler's
 * result and puts beside `data` rather than inside it — so `payload()` alone
 * never sees it.
 */
export async function paginationOf(res: APIResponse) {
  const body = (await res.json()) as {
    pagination?: {
      page: number;
      limit: number;
      totalItems: number;
      totalPages: number;
      hasNextPage: boolean;
      hasPreviousPage: boolean;
    };
  };
  if (!body.pagination) {
    throw new Error(
      `expected a pagination block, got ${JSON.stringify(body).slice(0, 300)}`,
    );
  }
  return body.pagination;
}

export function b64url(input: string | Buffer): string {
  return Buffer.from(input)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/**
 * Mints an access token by hand.
 *
 * playwright.config.ts loads .env.e2e, so the suite holds the same JWT_SECRET
 * the server does and can build claims no endpoint would ever issue — expired,
 * signed with the partner secret, or naming a subject that does not exist.
 * Nothing else reaches those branches of JwtStrategy.
 */
export function mintToken(
  claims: Record<string, unknown>,
  opts: { secret?: string } = {},
): string {
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64url(JSON.stringify(claims));
  const signature = b64url(
    createHmac('sha256', opts.secret ?? process.env.JWT_SECRET ?? '')
      .update(`${header}.${body}`)
      .digest(),
  );
  return `${header}.${body}.${signature}`;
}

/**
 * Walks the ledger as a chain.
 *
 * Two debits that interleave both read the same balance, so both write the
 * same `balanceBefore` — and the second silently discards the first's
 * subtraction. Starting at the opening balance and stepping through entries by
 * matching `balanceBefore` to the running value proves the opposite: every
 * entry picked up exactly where another left off, which is only true if the
 * row lock serialised them. Returns the closing balance.
 */
export function walkLedger(
  rows: { balanceBefore: string; balanceAfter: string }[],
  from: number,
): number {
  const remaining = rows.map((r) => ({
    before: Number(r.balanceBefore),
    after: Number(r.balanceAfter),
  }));
  let current = from;

  while (remaining.length > 0) {
    const index = remaining.findIndex((r) => r.before === current);
    if (index === -1) {
      throw new Error(
        `the ledger breaks at ${current}: no entry starts there. ` +
          `Unlinked entries: ${JSON.stringify(remaining)}`,
      );
    }
    current = remaining.splice(index, 1)[0].after;
  }
  return current;
}

export async function walletOf(userId: string): Promise<WalletRow | null> {
  const [row] = await sql<{
    id: string;
    userId: string;
    balance: string;
    currency: string;
    version: number;
  }>(
    `SELECT "id", "userId", "balance", "currency", "version"
         FROM "wallets" WHERE "userId" = $1`,
    [userId],
  );
  return row
    ? { ...row, balance: Number(row.balance), version: Number(row.version) }
    : null;
}

export async function balanceOf(userId: string): Promise<number> {
  const wallet = await walletOf(userId);
  if (!wallet) throw new Error(`no wallet row for ${userId}`);
  return wallet.balance;
}

export async function ledgerOf(userId: string): Promise<TxRow[]> {
  return sql<TxRow>(
    `SELECT t.* FROM "wallet_transactions" t
         JOIN "wallets" w ON w."id" = t."walletId"
        WHERE w."userId" = $1
        ORDER BY t."createdAt" ASC`,
    [userId],
  );
}

/**
 * Moves a wallet to `target` with one coherent adjusting entry.
 *
 * A thin name over seedLedger because that is what the concurrency and balance
 * specs mean — "put this wallet on 0.60" — and `{ to: 0.6 }` at nine call
 * sites reads worse than the verb. A target the wallet is already on files
 * nothing, which is what it has always done.
 */
export async function fundWallet(
  userId: string,
  target: number,
): Promise<void> {
  await seedLedger(userId, {
    to: target,
    description: 'e2e fixture adjustment',
  });
}

/**
 * A message that a status check will bill for.
 *
 * The debit is deferred to the first transition to DELIVERED, and the only
 * customer-reachable route that makes that transition is
 * POST /messages/:id/check-status — the console provider reports every id as
 * delivered. So this is how a debit is driven over HTTP at all; there is no
 * endpoint that spends a wallet directly.
 */
export async function seedBillableMessage(userId: string): Promise<string> {
  const id = await seedDeliveredMessage(userId, {
    status: 'sent',
    costAmount: OTP_COST,
  });
  // Without a provider id the sync short-circuits and nothing is ever billed.
  await sql(`UPDATE "messages" SET "providerMsgId" = $2 WHERE "id" = $1`, [
    id,
    `console_${id}`,
  ]);
  return id;
}

export async function seedBillableMessages(
  userId: string,
  count: number,
): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < count; i += 1) {
    ids.push(await seedBillableMessage(userId));
  }
  return ids;
}

/**
 * Fires a status check, which is the only customer-reachable debit.
 *
 * Callers below assert `res.ok()` rather than a literal, and that is
 * deliberate in both directions:
 *
 *  - On success the route answers **201**. It is a plain `@Post()` with no
 *    `@HttpCode`, so it takes Nest's default for POST — the same 201 that
 *    admin/ops-wallet-credits pins on POST /admin/wallet/topup.
 *    (messages/delivery-status asserts 201 for this route too.) Nothing in
 *    tests/e2e/wallet/concurrency.spec.ts turns on which 2xx it is, so `ok()`
 *    says what is meant.
 *  - There is no longer a refusal branch to describe. This route settles a
 *    message that has already been delivered, so an unaffordable charge is
 *    booked and the wallet goes into arrears rather than throwing — the send
 *    cannot be un-sent, and refusing only lost the record of it. The
 *    `InsufficientBalanceError` that used to surface here as an untyped 500 is
 *    gone with the throw; `ErrorCodes.INSUFFICIENT_BALANCE` still guards the
 *    send itself in OtpService, which is where refusing saves money.
 */
export function checkStatus(
  request: APIRequestContext,
  token: string,
  messageId: string,
) {
  return request.post(`/messages/${messageId}/check-status`, {
    headers: auth(token),
  });
}

/** Deletes a customer's wallet and its history, FK order respected. */
export async function removeWallet(userId: string): Promise<void> {
  await sql(
    `DELETE FROM "wallet_transactions"
        WHERE "walletId" IN (SELECT "id" FROM "wallets" WHERE "userId" = $1)`,
    [userId],
  );
  await sql(`DELETE FROM "wallets" WHERE "userId" = $1`, [userId]);
}

export const txUrl = (query = '') =>
  query ? `/wallet/transactions?${query}` : '/wallet/transactions';

export function listTx(request: APIRequestContext, token: string, query = '') {
  return request.get(txUrl(query), { headers: auth(token) });
}
