import { expect, APIResponse } from '@playwright/test';
import { sql } from '../helpers/db.js';
import { seedDeliveredMessage } from '../helpers/actors.js';
import { seedLedger } from '../helpers/wallet.js';

/**
 * Shared fixtures for the seams around the customer message history
 * (`/messages`) and the customer dashboard (`/dashboard`).
 *
 * Both controllers are thin, and everything that can go wrong lives just
 * underneath them: a query DTO that decides what reaches Postgres, a hand-
 * written column projection that decides what the customer is allowed to see,
 * and — on the status check — the deferred wallet debit, which is the only
 * place in this pair of controllers where money moves. The fixtures below are
 * what those specs build those situations out of.
 */

/** The `{ code, message }` half of an error envelope. */
export async function errorOf(res: APIResponse) {
  const body = (await res.json()) as {
    error: { code: string; message: string };
  };
  return body.error;
}

/**
 * Columns the customer projection in MessagesService deliberately withholds.
 *
 * They are not merely uninteresting: `providerFailureReason` names the
 * upstream provider, `metadata` carries its raw payload, and
 * `renderedContent` is the exact text handed over. A previous version of
 * `checkStatus` returned the whole entity on one of its branches, which is
 * the incident this list exists to re-check.
 */
export const PROVIDER_ONLY_FIELDS = [
  'provider',
  'providerMsgId',
  'providerCost',
  'providerStatusDescription',
  'providerFailureReason',
  'renderedContent',
  'metadata',
  'senderId',
  'smsLanguage',
  'characterCount',
  'smsCount',
  'otpTemplateId',
  'otpRequestId',
  'deletedAt',
];

export const SECRET_RENDERED = 'Rendered body 9#9#9 for AcmeCorp';
export const SECRET_METADATA = 'provider-raw-payload-must-not-leak';

export function expectNoProviderDetail(row: Record<string, unknown>) {
  for (const field of PROVIDER_ONLY_FIELDS) {
    expect(row, `"${field}" reached the customer`).not.toHaveProperty(field);
  }
  const text = JSON.stringify(row);
  expect(text).not.toContain(SECRET_RENDERED);
  expect(text).not.toContain(SECRET_METADATA);
}

/**
 * A message carrying everything the provider wrote on it.
 *
 * Built on the sanctioned seed helper and then widened, because the helper
 * only writes the columns the affiliate tests need and the leak this guards
 * against is in the columns it does not write.
 */
export async function seedProviderMessage(
  userId: string,
  opts: {
    status?: string;
    costAmount?: number;
    providerMsgId?: string | null;
    createdAt?: Date;
  } = {},
): Promise<string> {
  const id = await seedDeliveredMessage(userId, {
    status: opts.status ?? 'delivered',
    costAmount: opts.costAmount ?? 0.25,
    updatedAt: opts.createdAt,
  });
  await sql(
    `UPDATE "messages"
        SET "providerMsgId"          = $2,
            "renderedContent"        = $3,
            "providerFailureReason"  = 'Provider said: DND scrubbed',
            "providerStatusDescription" = 'PROVIDER_INTERNAL_OK',
            "senderId"               = 'ACMESM',
            "providerCost"           = 0.11,
            "metadata"               = $4::jsonb
      WHERE "id" = $1`,
    [
      id,
      opts.providerMsgId ?? null,
      SECRET_RENDERED,
      JSON.stringify({ report_payload: SECRET_METADATA }),
    ],
  );
  return id;
}

/**
 * Puts a customer's wallet on `balance`.
 *
 * The upsert this used to be wrote the balance column and nothing else, so
 * delivery-status.spec.ts asserted an insufficient-balance refusal against a
 * figure no ledger backed. The four `setBalance(customer.id, 10)` calls in
 * that spec are already on ten from the welcome credit and so still file
 * nothing at all; only the drop to 0.10 now writes the debit that explains it.
 */
export async function setBalance(userId: string, balance: number) {
  await seedLedger(userId, {
    to: balance,
    description: 'e2e fixture adjustment',
  });
}

export async function balanceOf(userId: string): Promise<number> {
  const [row] = await sql<{ balance: string }>(
    `SELECT "balance" FROM "wallets" WHERE "userId" = $1`,
    [userId],
  );
  return Number(row?.balance ?? 0);
}

/** Every debit booked against one message, in paise-exact rupees. */
export async function debitsFor(messageId: string): Promise<number[]> {
  const rows = await sql<{ amount: string }>(
    `SELECT "amount" FROM "wallet_transactions"
      WHERE "referenceId" = $1 AND "type" = 'debit'`,
    [messageId],
  );
  return rows.map((r) => Number(r.amount));
}

export async function messageRow(id: string) {
  const [row] = await sql<{
    status: string;
    costAmount: string;
    updatedAt: Date;
    statusHistory: { status: string }[];
  }>(
    `SELECT "status", "costAmount", "updatedAt", "statusHistory"
       FROM "messages" WHERE "id" = $1`,
    [id],
  );
  return row;
}

/** Today's IST calendar date, the key the trends endpoint groups on. */
export function istToday(): string {
  return new Date(Date.now() + 5.5 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

export const daysAgo = (n: number) =>
  new Date(Date.now() - n * 24 * 60 * 60 * 1000);

/**
 * Three delivered at 0.25 today, one failed, one still in flight at a cost
 * that must never be counted, and one delivered nine days ago.
 */
export async function seedSpread(userId: string) {
  for (let i = 0; i < 3; i += 1) {
    // Seconds apart, not minutes: these have to stay on today's IST
    // calendar day even when the suite runs just after midnight.
    await seedDeliveredMessage(userId, {
      costAmount: 0.25,
      updatedAt: new Date(Date.now() - i * 1_000),
    });
  }
  await seedDeliveredMessage(userId, { status: 'failed', costAmount: 0 });
  // A `sent` message carries an intended cost that has not been earned yet.
  await seedDeliveredMessage(userId, { status: 'sent', costAmount: 5 });
  await seedDeliveredMessage(userId, {
    costAmount: 1,
    updatedAt: daysAgo(9),
  });
}

export interface Stats {
  filtered: {
    requested: number;
    delivered: number;
    failed: number;
    cost: number;
  };
  total: { messages: number; cost: number };
}
