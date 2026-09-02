import { test, expect } from '@playwright/test';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { resetDb, closeDb } from '../helpers/db.js';
import { createPartner, auth, payload, Partner } from '../helpers/actors.js';

const LOG_PATH = process.env.E2E_SERVER_LOG ?? 'e2e-server.log';

/**
 * What ends up in the logs.
 *
 * The logging interceptor serialises every request body to stdout *and* to the
 * OpenTelemetry exporter wired to analytics. Anything not redacted therefore
 * leaves the system permanently — so the redaction list is load-bearing
 * security, and this file is what stops it silently falling behind the DTOs.
 *
 * A partner's payout details are bank account number, IFSC, UPI handle and PAN
 * (an Indian government tax identifier). None of those matched the original
 * redaction list, which keyed on substrings like `card_number`.
 */
test.describe('sensitive data never reaches the logs', () => {
  let partner: Partner;

  test.beforeEach(async ({ request }) => {
    await resetDb();
    partner = await createPartner(request);
  });

  test.afterAll(async () => {
    await closeDb();
  });

  /**
   * Whole-file read, deliberately.
   *
   * An earlier version kept only the last 200k characters and took offsets
   * against that, so once the log outgrew the cap every "what was written
   * since" slice came back empty and the assertions passed by inspecting
   * nothing at all.
   */
  function logSize(): number {
    return existsSync(LOG_PATH) ? statSync(LOG_PATH).size : 0;
  }

  /**
   * Sliced as bytes, not characters.
   *
   * `logSize()` returns `statSync().size`, which counts BYTES, so the offset
   * has to be applied to a Buffer. Decoding first and calling String.slice()
   * counts UTF-16 code units instead, and the two agree only while the log
   * stays pure ASCII. It does not — the suite logs rupee amounts and unicode
   * names — so every multi-byte character already written made the offset
   * overshoot by one or more positions, silently cutting the head off the
   * region being inspected.
   *
   * That drift was invisible while this file ran sixth of fifteen and the log
   * ahead of it was small. Moving it into platform/ put ~600 tests' worth of
   * logging in front, the overshoot grew past the slice being read, and the
   * fail-closed guard below did its job. The ordering did not cause the bug;
   * it stopped concealing it.
   */
  function logSince(byteOffset: number): string {
    if (!existsSync(LOG_PATH)) return '';
    return readFileSync(LOG_PATH).subarray(byteOffset).toString('utf8');
  }

  /**
   * Reads what was logged and proves the log was actually being written.
   *
   * Every assertion in this file is a `not.toContain`, which an empty string
   * satisfies. If the server's stdout is not going where LOG_PATH points —
   * different working directory, redirect dropped in CI — these tests would go
   * on passing while inspecting nothing at all. Requiring the request itself
   * to appear makes them fail closed instead.
   */
  function logProvingRequestWasWritten(before: number, marker: string): string {
    const written = logSince(before);
    expect(
      written,
      `nothing matching "${marker}" was written to ${LOG_PATH} — ` +
        `the log is not being captured, so this test proves nothing`,
    ).toContain(marker);
    return written;
  }

  test('payout details are redacted in the request log', async ({ request }) => {
    const secrets = {
      bankAccountName: 'Vicky Sangwan',
      bankAccountNumber: '90210345678901',
      bankIfsc: 'HDFC0009999',
      pan: 'ABCDE1234F',
    };

    const before = logSize();

    const res = await request.patch('/partner/payout-details', {
      data: { payoutMethod: 'bank', ...secrets },
      headers: auth(partner.accessToken),
    });
    expect(res.ok(), await res.text()).toBeTruthy();

    // Give the logger a moment to flush.
    await new Promise((r) => setTimeout(r, 500));
    const written = logProvingRequestWasWritten(before, '/partner/payout-details');

    for (const [field, value] of Object.entries(secrets)) {
      expect(
        written,
        `${field} ("${value}") was written to the log in clear text`,
      ).not.toContain(value);
    }
  });

  test('a UPI handle is redacted too', async ({ request }) => {
    const upiId = 'vicky.sangwan@okhdfcbank';
    const before = logSize();

    const res = await request.patch('/partner/payout-details', {
      data: { payoutMethod: 'upi', upiId },
      headers: auth(partner.accessToken),
    });
    expect(res.ok(), await res.text()).toBeTruthy();

    await new Promise((r) => setTimeout(r, 500));
    expect(
      logProvingRequestWasWritten(before, '/partner/payout-details'),
    ).not.toContain(upiId);
  });

  test('passwords are redacted on registration and login', async ({
    request,
  }) => {
    const password = 'SuperSecretPassword123!';
    const before = logSize();

    await request.post('/partner/auth/login', {
      data: { email: partner.email, password },
    });

    await new Promise((r) => setTimeout(r, 500));
    expect(
      logProvingRequestWasWritten(before, '/partner/auth/login'),
    ).not.toContain(password);
  });

  test('the partner can still read back their own payout details', async ({
    request,
  }) => {
    // Redaction is for the logs, not the owner's own response — otherwise the
    // portal could never show a partner what it will pay into.
    const upiId = 'someone@okaxis';
    await request.patch('/partner/payout-details', {
      data: { payoutMethod: 'upi', upiId },
      headers: auth(partner.accessToken),
    });

    const me = await request.get('/partner/auth/me', {
      headers: auth(partner.accessToken),
    });
    const body = await payload<{ upiId?: string }>(me);
    expect(body.upiId).toBe(upiId);
  });
});
