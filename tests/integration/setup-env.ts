/**
 * Points the in-process suite at the isolated test database.
 *
 * Without this, nothing loads an env file at all and AppModule refuses to
 * construct — Joi rejects the missing DATABASE_* and *_JWT_SECRET values — so
 * `npm run test:e2e` failed before a single assertion ran.
 *
 * `.env.e2e` rather than `.env` deliberately: this suite boots the real
 * AppModule against a real database, and the one it must never boot against is
 * the developer's own. `override: true` because a stray DATABASE_NAME already
 * in the shell would otherwise win and quietly aim the run somewhere else.
 */
import { config } from 'dotenv';
import { resolve } from 'node:path';

config({
  path: resolve(__dirname, '../../.env.e2e'),
  override: true,
  quiet: true,
});

const name = process.env.DATABASE_NAME ?? '';
if (!/e2e|test/i.test(name)) {
  throw new Error(
    `refusing to boot the integration suite against "${name}" — ` +
      'it is not an e2e/test database. Check tests/integration/setup-env.ts.',
  );
}
