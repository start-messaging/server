import { Client } from 'pg';
import Redis from 'ioredis';
import { bullPrefix } from '../../../src/common/constants/redis-keys.constants.js';

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
  // `sm_db` — the development database on the same Postgres — holds real
  // users, messages and leads. `sm_test` is the only acceptable target.
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
 * Clears the suite's own Redis keys — everything except the queues.
 *
 * Rate-limit counters live there and are keyed on IP, so without this the
 * fifth registration in a run would 429 and every later test would fail for a
 * reason unrelated to what it asserts. OTP state and cached values go the same
 * way.
 *
 * BullMQ's namespace is deliberately spared. This used to be a FLUSHDB, which
 * was survivable only because BullMQ dropped the `/N` from REDIS_URL and put
 * every queue on logical DB 0 — the suite was never actually clearing its own
 * queues. Now that the connection honours the path, the queues sit in this DB,
 * and deleting a queue's keys under a running worker leaves that worker
 * blocked on a BZPOPMIN against a stream that no longer exists: jobs stop
 * moving and the next test times out waiting for a webhook that will never be
 * processed. Sparing them keeps the behaviour the suite has always had.
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

  // Without a prefix, BullMQ writes to the bare `bull:*` keyspace — the same
  // one the developer's dev API is using — and the two runs pull each other's
  // jobs off the queues. That is what made the webhook tests fail in a
  // different combination every run. The prefix is what keeps them apart, and
  // it is also the only thing scoping the deletion below, so a run without one
  // is refused rather than left to clear someone else's keys.
  //
  // The shape is checked here and not just trusted: the Joi pattern that
  // enforces it lives in src/config/validation.ts and runs in the API
  // process, not in this one, so nothing upstream of this line has looked at
  // the value. A prefix carrying a glob metacharacter — `*`, `?`, `[` — widens
  // the SCAN below past the suite's own keys.
  const prefix = process.env.REDIS_KEY_PREFIX;
  if (!prefix || !/^[A-Za-z0-9_-]+$/.test(prefix)) {
    throw new Error(
      `Refusing to run E2E tests with REDIS_KEY_PREFIX="${prefix ?? ''}": it must match ` +
        '[A-Za-z0-9_-]+. Empty, the suite shares the bare `bull:*` keyspace with the dev ' +
        'API and the two steal jobs from each other; with a glob character in it, the ' +
        "scan below reaches past the suite's own keys.",
    );
  }

  const redis = new Redis(url, {
    // No reconnect loop. A Redis that is down should fail the first spec
    // outright, not stall every one of them: with the defaults, commands sat
    // queued against a dead port past the 30s Playwright timeout, so every
    // spec died complaining about whatever it was asserting instead.
    retryStrategy: () => null,
    maxRetriesPerRequest: 1,
  });
  // ioredis emits 'error' as well as rejecting the command; unhandled, that
  // event takes the whole Playwright worker down instead of failing one test.
  redis.on('error', () => {});

  try {
    // The namespace BullMQ is handed in src/app.module.ts, from the one
    // function both sides read — reconstructed here, a change on either side
    // would silently stop sparing the queues, or start deleting them.
    const queues = bullPrefix(prefix);
    let cursor = '0';
    do {
      // SCAN, not KEYS: the dev API may be pointed at this Redis too, and a
      // KEYS sweep blocks the server for every one of its clients.
      const [next, keys] = await redis.scan(
        cursor,
        'MATCH',
        `${prefix}:*`,
        'COUNT',
        500,
      );
      cursor = next;
      const doomed = keys.filter(
        (k) => k !== queues && !k.startsWith(`${queues}:`),
      );
      if (doomed.length) await redis.unlink(...doomed);
    } while (cursor !== '0');
  } finally {
    // disconnect(), not quit(): quit() on a connection that never came up
    // rejects, and the rejection replaces the error that got us here.
    redis.disconnect();
  }
}

/** Tables the suite owns, ordered so truncation never trips a foreign key. */
const TABLES = [
  'lead_outreach_events',
  'lead_ingest_runs',
  'leads',
  'outreach_suppressions',
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

  // Same singleton treatment for the leads pipeline knobs: NULL = "use the
  // env default", which is the shipped state a test must start from.
  await c.query(`
    UPDATE "lead_pipeline_settings"
       SET "ingestEnabled"       = NULL,
           "livenessEnabled"     = NULL,
           "enrichEnabled"       = NULL,
           "enrichBatchPerSweep" = NULL,
           "enrichConcurrency"   = NULL,
           "enrichRecrawlHours"  = NULL,
           "updatedAt"           = now()
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
