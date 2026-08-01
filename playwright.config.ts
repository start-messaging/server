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
    command: 'node dist/main.js',
    url: `${BASE_URL}/health`,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env } as Record<string, string>,
  },
});
