import { expect } from '@playwright/test';
import { sql } from '../helpers/db.js';
import { seedDeliveredMessage } from '../helpers/actors.js';
import { seedLedger } from '../helpers/wallet.js';

/**
 * Shared fixtures for the 2Factor delivery report callback
 * (`/webhooks/2factor`, POST and GET) — one of the two routes nobody has to
 * authenticate to reach.
 *
 * The webhook is the only place in the product where an anonymous request
 * moves money. It carries no signature, no shared secret and no allowlist —
 * 2Factor simply POSTs a `SessionId` — so the entire boundary between one
 * customer's messages and another's is the unguessability of that id. That is
 * worth pinning precisely: the controller answers 200 to anything it is
 * handed, enqueues the body on a BullMQ queue, and the worker looks the
 * SessionId up across every tenant at once and debits whoever owns the match.
 *
 * The tests these fixtures serve therefore assert against the database, not
 * the response: the response is `{received:true}` no matter what happened, by
 * design. That is why the readers below go straight to SQL.
 */

export const WEBHOOK = '/webhooks/2factor';

/**
 * What an OTP send actually costs in this environment.
 *
 * Written into the fixture's own metadata rather than read from config: the
 * debit reads `metadata.intendedCost` off the message row, so the tests own
 * the number end to end and a config change cannot quietly rewrite what they
 * assert.
 */
export const INTENDED_COST = 0.25;

export interface MessageRow {
  status: string;
  costAmount: string;
  deliveredAt: Date | null;
  failureReason: string | null;
  providerFailureReason: string | null;
  metadata: Record<string, any> | null;
  historyLength: number;
}

export async function messageRow(id: string): Promise<MessageRow> {
  // Deliberately raw rather than through the service: TypeORM hides
  // soft-deleted rows, and one of the tests below is about exactly those.
  const [row] = await sql<MessageRow>(
    `SELECT "status", "costAmount", "deliveredAt", "failureReason",
            "providerFailureReason", "metadata",
            jsonb_array_length("statusHistory") AS "historyLength"
       FROM "messages" WHERE "id" = $1`,
    [id],
  );
  return row;
}

export async function walletBalance(userId: string): Promise<number> {
  const [row] = await sql<{ balance: string }>(
    `SELECT "balance" FROM "wallets" WHERE "userId" = $1`,
    [userId],
  );
  return Number(row?.balance ?? 0);
}

/** Every ledger entry raised against one message, in the order it was written. */
export async function ledgerFor(messageId: string) {
  return sql<{
    type: string;
    amount: string;
    balanceBefore: string;
    balanceAfter: string;
    referenceType: string | null;
  }>(
    `SELECT "type", "amount", "balanceBefore", "balanceAfter", "referenceType"
       FROM "wallet_transactions"
      WHERE "referenceId" = $1
      ORDER BY "createdAt"`,
    [messageId],
  );
}

/**
 * Puts a tenant's wallet on `balance`.
 *
 * This used to upsert the balance column on its own, which left every wallet
 * in this suite claiming a figure its own ledger did not add up to — invisible
 * here, because ledgerFor() filters on referenceId and never sees a fixture
 * row, and visible the moment anything derives a balance from the ledger. It
 * delegates now; the entry it files carries no reference pair, exactly like
 * the adjustments in the wallet suite.
 */
export async function fundWallet(
  userId: string,
  balance: number,
): Promise<void> {
  await seedLedger(userId, {
    to: balance,
    description: 'e2e fixture adjustment',
  });
}

/**
 * A message in the state a real 2Factor send leaves behind.
 *
 * `sent`, nothing charged yet, the intended charge parked in metadata and the
 * provider's SessionId in `providerMsgId` — that column is the only thing a
 * webhook can key on, and no sanctioned seed helper writes it, so the fixture
 * is the delivered-message seeder widened in place (the same pattern
 * tests/e2e/messages/helpers.ts uses).
 */
export async function seedSentMessage(
  userId: string,
  opts: {
    sessionId: string;
    intendedCost?: number;
    status?: string;
    costAmount?: number;
    /** A stale reason, for rows written before the "only FAILED carries one" rule. */
    failureReason?: string;
  },
): Promise<string> {
  const id = await seedDeliveredMessage(userId, {
    status: opts.status ?? 'sent',
    costAmount: opts.costAmount ?? 0,
  });
  await sql(
    `UPDATE "messages"
        SET "providerMsgId"  = $2,
            "metadata"       = $3::jsonb,
            "statusHistory"  = '[]'::jsonb,
            "failureReason"  = $4,
            "deliveredAt"    = NULL
      WHERE "id" = $1`,
    [
      id,
      opts.sessionId,
      JSON.stringify({ intendedCost: opts.intendedCost ?? INTENDED_COST }),
      opts.failureReason ?? null,
    ],
  );
  return id;
}

export async function pollStatus(
  messageId: string,
  expected: string,
): Promise<void> {
  await expect
    .poll(async () => (await messageRow(messageId)).status, {
      message: `the webhook worker never moved message ${messageId} to "${expected}"`,
      timeout: 15_000,
      intervals: [100, 200, 300, 500, 1000],
    })
    .toBe(expected);
}
