import { Client } from 'pg';

/**
 * Direct database access for the E2E suite.
 *
 * Tests assert against the ledger rather than only against API responses,
 * because the defects this suite exists to catch are precisely the ones where
 * the response looks right and the stored money does not.
 */

let client: Client | null = null;

export async function db(): Promise<Client> {
  if (client) return client;

  const name = process.env.DATABASE_NAME;
  // A guard, not a formality. Every reset in this file truncates, and
  // `sm_verify` holds a restore of production data.
  if (!name || !/e2e|test/i.test(name)) {
    throw new Error(
      `Refusing to run E2E tests against database "${name}". ` +
        `The suite truncates tables; point DATABASE_NAME at a dedicated test database.`,
    );
  }

  client = new Client({
    host: process.env.DATABASE_HOST,
    port: Number(process.env.DATABASE_PORT ?? 5432),
    database: name,
    user: process.env.DATABASE_USERNAME,
    password: process.env.DATABASE_PASSWORD,
  });
  await client.connect();
  return client;
}

export async function closeDb(): Promise<void> {
  await client?.end();
  client = null;
}

export async function sql<T = Record<string, unknown>>(
  text: string,
  params: unknown[] = [],
): Promise<T[]> {
  const c = await db();
  const res = await c.query(text, params);
  return res.rows as T[];
}

/**
 * Clears the Redis logical DB the suite uses.
 *
 * Rate-limit counters live there and are keyed on IP, so without this the
 * fifth registration in a run would 429 and every later test would fail for a
 * reason unrelated to what it asserts. It also drops BullMQ state between
 * tests, which the scheduler re-registers on demand.
 */
export async function flushRedis(): Promise<void> {
  const url = process.env.REDIS_URL;
  if (!url) return;

  // Same guard as the database: never flush a Redis DB that is not the
  // suite's own. `redis://host:port/N` — anything without an explicit
  // non-zero logical DB is refused.
  const dbIndex = new URL(url).pathname.replace('/', '');
  if (!dbIndex || dbIndex === '0') {
    throw new Error(
      `Refusing to flush Redis at "${url}": the E2E suite needs its own logical DB (e.g. /14).`,
    );
  }

  const { createClient } = await import('redis');
  const client = createClient({ url });
  await client.connect();
  await client.flushDb();
  await client.quit();
}

/** Tables the suite owns, ordered so truncation never trips a foreign key. */
const TABLES = [
  'partner_commissions',
  'partner_payouts',
  'referral_clicks',
  'referrals',
  'partners',
  'messages',
  'wallet_transactions',
  'payments',
  'wallets',
  'api_keys',
  'users',
];

/**
 * Returns the database to a known state.
 *
 * `affiliate_settings` is reset to the shipped defaults rather than truncated:
 * it is a singleton the application self-heals, and re-creating it per test
 * would hide the very invariants under test.
 */
export async function resetDb(): Promise<void> {
  await flushRedis();
  const c = await db();
  const existing = await sql<{ tablename: string }>(
    `SELECT tablename FROM pg_tables WHERE schemaname = 'public'`,
  );
  const present = new Set(existing.map((r) => r.tablename));
  const targets = TABLES.filter((t) => present.has(t));

  await c.query(
    `TRUNCATE TABLE ${targets.map((t) => `"${t}"`).join(', ')} RESTART IDENTITY CASCADE`,
  );

  await c.query(`
    UPDATE "affiliate_settings"
       SET "isEnabled"             = false,
           "defaultCommissionType" = 'percent',
           "defaultCommissionRate" = 10,
           "minPaidReferrals"      = 10,
           "minPayoutAmount"       = 1000,
           "payoutDayOfMonth"      = 25,
           "cookieDurationDays"    = 60,
           "accrualIntervalHours"  = 48,
           "accrualLookbackHours"  = 168,
           "lastAccrualAt"         = NULL,
           "updatedAt"             = now()
     WHERE "isSingleton" = true
  `);
}

/** Reads the settings singleton straight from the row. */
export async function readSettings() {
  const [row] = await sql(
    `SELECT * FROM "affiliate_settings" WHERE "isSingleton" = true`,
  );
  return row as Record<string, string | number | boolean | Date | null>;
}

/** The three cached money columns plus the ledger truth, for drift assertions. */
export async function partnerTotals(partnerId: string) {
  const [cached] = await sql<{
    lifetime: string;
    unpaid: string;
    paid: string;
  }>(
    `SELECT "lifetimeEarnings" AS lifetime, "unpaidEarnings" AS unpaid, "paidEarnings" AS paid
       FROM "partners" WHERE "id" = $1`,
    [partnerId],
  );

  const [ledger] = await sql<{
    lifetime: string;
    unpaid: string;
    paid: string;
  }>(
    `SELECT
       COALESCE(SUM("amount") FILTER (WHERE "status" IN ('accrued','paid')), 0) AS lifetime,
       COALESCE(SUM("amount") FILTER (WHERE "status" = 'accrued'), 0) AS unpaid,
       COALESCE(SUM("amount") FILTER (WHERE "status" = 'paid'), 0) AS paid
     FROM "partner_commissions"
     WHERE "partnerId" = $1 AND "deletedAt" IS NULL`,
    [partnerId],
  );

  return {
    cached: {
      lifetime: Number(cached?.lifetime ?? 0),
      unpaid: Number(cached?.unpaid ?? 0),
      paid: Number(cached?.paid ?? 0),
    },
    ledger: {
      lifetime: Number(ledger?.lifetime ?? 0),
      unpaid: Number(ledger?.unpaid ?? 0),
      paid: Number(ledger?.paid ?? 0),
    },
  };
}
