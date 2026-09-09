import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import Redis from 'ioredis';
import { bullPrefix } from '../../src/common/constants/redis-keys.constants.js';
import { acquireSuiteLock } from './suite-lock.js';

const SERVER_ROOT = join(__dirname, '..', '..');

/**
 * Refuses to run the suite against a build older than the source.
 *
 * `webServer` runs `node dist/main.js`, so an un-rebuilt `dist` means the
 * specs exercise the previous commit and say nothing about it. That is not
 * hypothetical: it happened while verifying the change that moved BullMQ onto
 * the logical DB named in REDIS_URL — the suite booted the old factory, wrote
 * its queues to db 0 anyway, and every spec still passed. CI is safe because
 * its Build step precedes this one; a local run has nothing to catch it.
 */
export function assertBuildIsCurrent(): void {
  const built = statSync(join(SERVER_ROOT, 'dist', 'main.js'), {
    throwIfNoEntry: false,
  })?.mtimeMs;
  if (built === undefined) {
    throw new Error(
      'dist/main.js is missing — the e2e suite runs the compiled output. Run `npm run build` first.',
    );
  }

  let newest = 0;
  let newestFile = '';
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.spec.ts')) {
        const { mtimeMs } = statSync(full);
        if (mtimeMs > newest) {
          newest = mtimeMs;
          newestFile = full.slice(SERVER_ROOT.length + 1);
        }
      }
    }
  };
  walk(join(SERVER_ROOT, 'src'));

  if (newest > built) {
    throw new Error(
      `dist/ is older than src/ (${newestFile} changed after dist/main.js was written). ` +
        'The suite runs `node dist/main.js`, so it would test the previous build and pass. ' +
        'Run `npm run build` first.',
    );
  }
}

/**
 * Clears the suite's BullMQ namespace once, before the API is started.
 *
 * `flushRedis()` in ./helpers/db.ts deliberately spares `${prefix}:bull*`
 * between tests: unlinking a queue's keys under a running worker leaves that
 * worker blocked on a BZPOPMIN against a stream that no longer exists, jobs
 * stop moving, and the next test times out waiting for a webhook that will
 * never be processed. Here there is nothing to strand — Playwright runs
 * globalSetup before the `webServer` command, so no worker is attached to
 * these queues yet. That is the whole reason this clear is safe and the same
 * clear between tests is not.
 *
 * Something has to do it, though. Queues used to land on logical DB 0 because
 * the BullMQ factory dropped the `/N` from REDIS_URL, so this suite's own DB
 * never accumulated any; now that the connection honours the path they live
 * here, and delayed, failed and repeat jobs from the previous run would
 * otherwise survive into the next one and be processed against tables that
 * have just been truncated out from under them.
 */
export default async function globalSetup(): Promise<void> {
  // Before the Redis sweep below, which would otherwise clear queue keys a
  // suite already running on this database is actively working.
  await acquireSuiteLock(
    {
      host: process.env.DATABASE_HOST ?? '127.0.0.1',
      port: Number(process.env.DATABASE_PORT ?? 5432),
      database: process.env.DATABASE_NAME ?? '',
      user: process.env.DATABASE_USERNAME ?? 'postgres',
      password: process.env.DATABASE_PASSWORD,
    },
    'the server API e2e suite',
  );

  const url = process.env.REDIS_URL;
  if (!url) return;

  // Same guard as flushRedis(). Logical DB 0 is shared with an unrelated
  // local project that owns the `generation` and `notifications-*` queues, so
  // a URL without an explicit non-zero `/N` is refused rather than swept.
  const dbIndex = new URL(url).pathname.replace('/', '');
  if (!dbIndex || dbIndex === '0') {
    throw new Error(
      `Refusing to clear BullMQ keys at "${url}": the E2E suite needs its own logical DB (e.g. /14).`,
    );
  }

  // Same guard as flushRedis(), plus the character set, because the prefix is
  // the only thing scoping the MATCH below and nothing has checked it yet:
  // the Joi rule in src/config/validation.ts runs when the API boots, which is
  // after this. Empty would sweep the bare `bull:*` keyspace the dev API sits
  // on, and a glob character would widen the pattern past the suite entirely.
  const prefix = process.env.REDIS_KEY_PREFIX;
  if (!prefix || !/^[A-Za-z0-9_-]+$/.test(prefix)) {
    throw new Error(
      `Refusing to run E2E tests with REDIS_KEY_PREFIX="${prefix ?? ''}": it is the only thing ` +
        'scoping this deletion, and without a plain [A-Za-z0-9_-] prefix the sweep would reach ' +
        "the dev API's queues.",
    );
  }

  const redis = new Redis(url, {
    // Fail fast. Nothing is running yet, so an unreachable Redis should say so
    // here rather than have ioredis retry in the background until the far
    // vaguer `webServer` health-check timeout is what the developer sees.
    maxRetriesPerRequest: 1,
    retryStrategy: () => null,
  });

  try {
    let cursor = '0';
    let removed = 0;
    do {
      // SCAN, not KEYS: the dev API may be pointed at this Redis too, and a
      // KEYS sweep blocks the server for every one of its clients.
      const [next, keys] = await redis.scan(
        cursor,
        'MATCH',
        `${bullPrefix(prefix)}*`,
        'COUNT',
        500,
      );
      cursor = next;
      if (keys.length) {
        await redis.unlink(...keys);
        removed += keys.length;
      }
    } while (cursor !== '0');

    if (removed) {
      console.log(
        `[e2e] cleared ${removed} leftover key(s) under "${prefix}:bull" on Redis db ${dbIndex}`,
      );
    }
  } finally {
    // disconnect(), not quit(): quit() sends a command, which on a connection
    // that never came up waits for a reply that is not going to arrive.
    redis.disconnect();
  }
}
