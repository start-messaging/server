import { sql } from './db.js';

/**
 * The one way an E2E fixture is allowed to move money.
 *
 * Before this there were five of them with three different meanings: two
 * `fundWallet`s (wallet/, webhooks/), two `setBalance`s (messages/, otp/), an
 * `api-keys/seedWallet`, a local `credit()` in wallet/otp-billing.spec.ts that
 * wrote debit rows, and six hand-copied inline statements. Some added a delta,
 * some set an absolute, some wrote a ledger row, some wrote only the balance
 * column, and none of them agreed on what the other columns should say. A
 * fixture that writes a row production cannot produce is a test asserting
 * against a state that cannot occur — and the database will not object,
 * because `wallets` and `wallet_transactions` carry no CHECK constraint and no
 * trigger (InitialSchema 1776902400000). The only money invariant Postgres
 * holds is the partial unique index of one otp_usage debit per message, and
 * nothing here writes that referenceType on purpose: the honest way to
 * exercise it is the real debit path (seedBillableMessage + checkStatus, or
 * POST /webhooks/2factor).
 *
 * What the production writers do, and therefore what this does:
 *
 *  - WalletService.performCredit / performReferencedDebit each write exactly
 *    one wallet_transactions row per move, whose balanceBefore/balanceAfter
 *    bracket that move, and each calls manager.save(wallet) exactly once
 *    (wallet.service.ts:297, :379). That save writes balance, bumps the
 *    @VersionColumn on Wallet (wallet.entity.ts:20) and touches the
 *    @UpdateDateColumn on BaseEntity — three columns a bare `SET "balance"`
 *    does not. wallet/concurrency.spec.ts counts versions against committed
 *    debits, so a fixture that moves money without a version bump is money the
 *    counter cannot see.
 *  - lockWallet creates a missing wallet with ON CONFLICT DO NOTHING, so a
 *    user seeded straight into `users` (actors.ts seedCustomer) gets a wallet
 *    at 0 rather than the TypeError the otp/ setBalance used to throw.
 *
 * `to` picks the type from the sign of the difference rather than emitting a
 * negative credit: AdminTopupDto floors a credit at 0.01, and admin revenue is
 * `SUM(amount) WHERE type='debit'` (WalletService.getAdminAnalytics), so a
 * wrong-signed row is money on a dashboard.
 */

interface EntryFields {
  description?: string;
  referenceType?: string;
  referenceId?: string;
  createdAt?: Date;
}

/** One money move: an explicit delta, or the balance to land on. */
export type LedgerEntry =
  | ({ delta: number; to?: never } & EntryFields)
  | ({ to: number; delta?: never } & EntryFields);

/** The columns are numeric(12,4); anything finer is rounded before it is sent. */
const paise = (n: number): number => Math.round(n * 1e4) / 1e4;

/**
 * Files one ledger entry per argument and leaves the wallet on the value they
 * add up to. Returns the closing balance.
 *
 * The first entry is a required parameter, so `seedLedger(id)` — which is what
 * `api-keys/seedWallet(id)` looked like before it grew a default — does not
 * compile into "move nothing" without anybody noticing. Pass an array where
 * the list is computed.
 */
export async function seedLedger(
  userId: string,
  first: LedgerEntry | LedgerEntry[],
  ...rest: LedgerEntry[]
): Promise<number> {
  const entries = [...(Array.isArray(first) ? first : [first]), ...rest];
  if (entries.length === 0) {
    throw new Error(`seedLedger(${userId}) was given no entries to file`);
  }

  await sql(
    `INSERT INTO "wallets" ("userId") VALUES ($1)
     ON CONFLICT ("userId") DO NOTHING`,
    [userId],
  );
  const [wallet] = await sql<{ id: string; balance: string }>(
    `SELECT "id", "balance" FROM "wallets" WHERE "userId" = $1`,
    [userId],
  );
  let balance = paise(Number(wallet.balance));

  for (const entry of entries) {
    const before = balance;
    // Split rather than folded into one expression so `to` narrows the union:
    // a target is rounded first and the move derived from it, a delta is
    // rounded first and the target derived from it.
    let delta: number;
    let after: number;
    if (entry.to !== undefined) {
      after = paise(entry.to);
      delta = paise(after - before);
    } else {
      delta = paise(entry.delta);
      after = paise(before + delta);
    }

    // A zero-value row is one production cannot write — AdminTopupDto is
    // @Min(0.01), and a debit of nothing never reaches the ledger — so
    // `{ to: 10 }` against a wallet already holding the ₹10 welcome credit
    // files nothing at all, which is what the balance-only fixtures this
    // replaces did at those same call sites.
    if (delta === 0) continue;

    balance = after;
    if (balance < 0) {
      throw new Error(
        `seedLedger would leave ${userId} holding ${balance}. ` +
          `performReferencedDebit refuses a debit larger than the balance ` +
          `(wallet.service.ts:341), so no production path reaches a negative ` +
          `wallet — file the credit that pays for these debits first.`,
      );
    }

    await sql(
      `INSERT INTO "wallet_transactions"
         ("walletId", "type", "amount", "balanceBefore", "balanceAfter",
          "referenceType", "referenceId", "description", "createdAt")
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, COALESCE($9::timestamptz, now()))`,
      [
        wallet.id,
        delta > 0 ? 'credit' : 'debit',
        Math.abs(delta),
        before,
        balance,
        entry.referenceType ?? null,
        entry.referenceId ?? null,
        entry.description ?? 'e2e ledger entry',
        entry.createdAt ?? null,
      ],
    );

    // One save per entry, the three columns together — what manager.save()
    // writes and what a bare `UPDATE ... SET "balance"` leaves behind.
    await sql(
      `UPDATE "wallets"
          SET "balance"   = $2,
              "version"   = "version" + 1,
              "updatedAt" = now()
        WHERE "id" = $1`,
      [wallet.id, balance],
    );
  }

  return balance;
}
