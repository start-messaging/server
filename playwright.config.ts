import { defineConfig } from '@playwright/test';
import { config as loadEnv } from 'dotenv';

// The suite is deliberately pointed at its own database and its own Redis
// logical DB. `sm_verify` holds a restore of production data; a test run
// truncates freely, so the two must never be the same target.
loadEnv({ path: '.env.e2e', override: true });

const PORT = process.env.PORT ?? '3010';
const BASE_URL = `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: './e2e',
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
