/**
 * Pins the test environment BEFORE any config/dotenv loads (via jest
 * `setupFiles` and a side-effect import in global-setup). @nestjs/config /
 * dotenv never override already-set process.env vars, so these win.
 *
 * The database name is FORCED to end in `_test` — global-setup rebuilds the
 * schema with `synchronize(true)` (drops everything), so it must never point at
 * a real database.
 */
process.env.NODE_ENV = 'test';

process.env.DATABASE_HOST = process.env.DATABASE_HOST ?? '127.0.0.1';
process.env.DATABASE_PORT = process.env.DATABASE_PORT ?? '5432';
process.env.DATABASE_USERNAME = process.env.DATABASE_USERNAME ?? 'postgres';
process.env.DATABASE_PASSWORD = process.env.DATABASE_PASSWORD ?? 'postgres';

const dbName = process.env.DATABASE_NAME ?? 'startmessaging_test';
process.env.DATABASE_NAME = dbName.endsWith('_test')
  ? dbName
  : 'startmessaging_test';

// global-setup empties the schema; the app rebuilds it via synchronize on boot.
process.env.DATABASE_SYNCHRONIZE = 'true';

// Redis logical db 15 for tests (dev/prod use 0).
process.env.REDIS_URL = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379/15';

process.env.JWT_SECRET =
  process.env.JWT_SECRET ?? 'test-jwt-secret-not-for-production-use';

// Console transports — never hit a real gateway during tests.
process.env.SMS_DRIVER = 'console';
process.env.MAIL_DRIVER = 'console';

// Cheapest bcrypt cost so auth specs stay fast.
process.env.BCRYPT_ROUNDS = process.env.BCRYPT_ROUNDS ?? '4';
