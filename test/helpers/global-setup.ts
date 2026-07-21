/* eslint-disable @typescript-eslint/no-unsafe-call */
// `pg` ships no types (no @types/pg in this project), so `Client` resolves to
// `any` — the raw SQL calls below are intentional test-infra plumbing.
import './set-test-env';
import { Client } from 'pg';

/**
 * Runs ONCE before the whole suite. Hard-refuses unless DATABASE_NAME ends in
 * `_test`, then drops + recreates the `public` schema so every run starts from
 * an empty database. The schema itself is (re)built by the first test app boot
 * via TypeORM `synchronize` (DATABASE_SYNCHRONIZE=true in the test env) — doing
 * it here would require loading entities, which the globalSetup module system
 * can't resolve (the app's `.js` ESM import specifiers aren't remapped outside
 * jest's runtime). Raw SQL avoids that entirely.
 */
export default async function globalSetup(): Promise<void> {
  const database = process.env.DATABASE_NAME;
  if (!database?.endsWith('_test')) {
    throw new Error(
      `Refusing to run e2e suite: DATABASE_NAME must end with "_test" (got "${database}")`,
    );
  }

  const client = new Client({
    host: process.env.DATABASE_HOST,
    port: parseInt(process.env.DATABASE_PORT ?? '5432', 10),
    user: process.env.DATABASE_USERNAME,
    password: process.env.DATABASE_PASSWORD,
    database,
  });

  await client.connect();
  await client.query('DROP SCHEMA IF EXISTS public CASCADE');
  await client.query('CREATE SCHEMA public');
  await client.query('CREATE EXTENSION IF NOT EXISTS "uuid-ossp"');
  await client.end();
}
