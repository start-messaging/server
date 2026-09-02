import { existsSync } from 'node:fs';
import { defineConfig } from '@playwright/test';
import { config as loadEnv } from 'dotenv';
import { assertBuildIsCurrent } from './tests/e2e/global-setup';

// The suite is deliberately pointed at `sm_test` and its own Redis logical
// DB. `sm_db` is the development database, holding real users, messages and
// leads; a test run truncates freely, so the two must never be the same
// target.
//
// `sm_test` is shared with the admin-panel and dashboard e2e suites, so those
// runs cannot overlap with this one — run them one at a time.
//
// `.env.e2e` is gitignored, so it cannot be the only source: a fresh clone has
// none, dotenv no-ops on a missing file, and the run then died deep in the db
// helper complaining about a DATABASE_NAME of `undefined` instead of saying
// there was no e2e config at all. `.env.ci` is the tracked, reviewable copy of
// the same values, so it stands in when there is no local override.
loadEnv({
  path: existsSync('.env.e2e') ? '.env.e2e' : '.env.ci',
  override: true,
});

// Before anything else, including the webServer: Playwright starts webServer
// as a plugin task *ahead* of globalSetup, so a check that lives in globalSetup
// would let a stale `dist` boot and only complain a minute later. The suite
// runs the compiled output, so an un-rebuilt dist tests the previous commit and
// passes while doing it.
assertBuildIsCurrent();

const PORT = process.env.PORT ?? '3010';
const BASE_URL = `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: './tests/e2e',
  // Clears leftover BullMQ jobs before the API boots — see the file for why
  // that is safe here and not between tests.
  globalSetup: './tests/e2e/global-setup.ts',
  globalTeardown: './tests/e2e/global-teardown.ts',
  // Serial. Nearly every affiliate assertion is about global state — the
  // settings singleton, a partner's cached balance, the accrual watermark — so
  // parallel workers sharing one database would interfere by construction.
  workers: 1,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: [['list']],
  timeout: 30_000,
  expect: { timeout: 10_000 },

  use: {
    baseURL: BASE_URL,
    extraHTTPHeaders: { 'Content-Type': 'application/json' },
    trace: 'retain-on-failure',
  },

  webServer: {
    // Runs the compiled output rather than `nest start`, so the suite exercises
    // the same artifact a deploy would.
    //
    // Output is teed to a file because one of the things under test is what
    // the logs contain: the interceptor writes every request body to stdout and
    // to the analytics exporter, so "a partner's bank details never appear in
    // a log line" is an assertion, not an assumption.
    command: `node dist/main.js > ${process.env.E2E_SERVER_LOG ?? 'e2e-server.log'} 2>&1`,
    url: `${BASE_URL}/health`,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env } as Record<string, string>,
  },
});
