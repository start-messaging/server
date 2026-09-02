import { Client } from 'pg';

/**
 * One suite at a time against the shared test database.
 *
 * The server API suite, both panel suites and the Jest specs all target
 * `sm_test`, and each of the three e2e suites TRUNCATEs a table list before
 * every test. Two of them overlapping does not fail cleanly — one truncates
 * rows the other has just seeded, and the result is a scatter of assertion
 * failures that name whatever was being tested rather than the collision.
 * Diagnosing exactly that cost a day: a run that looked like a queue race was
 * really two suites sharing a database.
 *
 * Four files carried a comment asking people to run them one at a time. This
 * is the same rule, enforced. A Postgres session advisory lock is the right
 * shape for it: it is held for as long as the connection lives and released
 * automatically when the process dies, so a suite killed with ctrl-C or an OOM
 * leaves nothing behind for the next run to clear.
 */

// Arbitrary but fixed: advisory locks are just a 64-bit number, and any two
// callers wanting the same lock must pick the same one. Derived from nothing —
// changing it silently stops the suites excluding each other.
const SUITE_LOCK_ID = 8_140_251_963_001;

let holder: Client | null = null;

export async function acquireSuiteLock(
  connection: {
    host: string;
    port: number;
    database: string;
    user: string;
    password?: string;
  },
  suiteName: string,
): Promise<void> {
  const client = new Client(connection);
  await client.connect();

  const { rows } = await client.query<{ locked: boolean }>(
    'SELECT pg_try_advisory_lock($1) AS locked',
    [SUITE_LOCK_ID],
  );

  if (!rows[0]?.locked) {
    // Name who is holding it. Without this the message is just "busy", and the
    // usual cause — a suite still running in another terminal — is invisible.
    // Postgres splits a bigint advisory key across classid/objid, so match on
    // both halves rather than on the key as one number — objid alone collides
    // with any other advisory lock sharing its low 32 bits.
    const { rows: others } = await client.query<{ application_name: string }>(
      `SELECT a.application_name
         FROM pg_locks l
         JOIN pg_stat_activity a ON a.pid = l.pid
        WHERE l.locktype = 'advisory'
          AND l.granted
          AND l.objsubid = 1
          AND l.classid = $1
          AND l.objid = $2`,
      [Math.floor(SUITE_LOCK_ID / 2 ** 32), SUITE_LOCK_ID % 2 ** 32],
    );
    await client.end();
    const who = others.map((o) => o.application_name || 'unknown').join(', ');
    throw new Error(
      `Another test suite is already running against "${connection.database}"` +
        (who ? ` (${who})` : '') +
        `. They TRUNCATE the same tables, so ${suiteName} refuses to start ` +
        'rather than interleave with it. Wait for the other run to finish.',
    );
  }

  holder = client;
}

export async function releaseSuiteLock(): Promise<void> {
  // Closing the connection releases the lock; the explicit unlock is only so
  // the release is visible in the logs of a run that ends normally.
  if (!holder) return;
  try {
    await holder.query('SELECT pg_advisory_unlock($1)', [SUITE_LOCK_ID]);
  } finally {
    await holder.end();
    holder = null;
  }
}
