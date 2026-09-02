import { test, expect } from '@playwright/test';
import { resetDb, closeDb, sql, readSettings } from '../helpers/db.js';
import {
  createAdmin,
  createCustomer,
  createPartner,
  updateSettings,
  auth,
  payload,
  Customer,
} from '../helpers/actors.js';

test.describe('settings invariants', () => {
  let admin: Customer;

  test.beforeEach(async ({ request }) => {
    await resetDb();
    admin = await createAdmin(request);
  });

  test.afterAll(async () => {
    await closeDb();
  });

  test('rejects a lookback shorter than the accrual interval', async ({
    request,
  }) => {
    // Both values are individually legal; only the pair is wrong, and a PATCH
    // may carry just one of them — so the check has to run against the merged
    // row, not the DTO.
    const res = await updateSettings(request, admin.accessToken, {
      accrualIntervalHours: 48,
      accrualLookbackHours: 6,
    });
    expect(res.status()).toBe(400);
    expect(await res.text()).toContain('accrualLookbackHours');

    const settings = await readSettings();
    expect(Number(settings.accrualLookbackHours)).toBe(168);
  });

  test('rejects the same inversion built up one field at a time', async ({
    request,
  }) => {
    // Lookback down to 12 first: legal on its own against the default 48? No —
    // it inverts the pair immediately, so it must be refused.
    const lower = await updateSettings(request, admin.accessToken, {
      accrualLookbackHours: 12,
    });
    expect(lower.status()).toBe(400);

    // Bring both down together, legally.
    expect(
      (
        await updateSettings(request, admin.accessToken, {
          accrualIntervalHours: 6,
          accrualLookbackHours: 12,
        })
      ).ok(),
    ).toBeTruthy();

    // Now raise only the interval past the lookback: also an inversion.
    const raise = await updateSettings(request, admin.accessToken, {
      accrualIntervalHours: 24,
    });
    expect(raise.status()).toBe(400);

    const settings = await readSettings();
    expect(Number(settings.accrualIntervalHours)).toBe(6);
    expect(Number(settings.accrualLookbackHours)).toBe(12);
  });

  test('the database refuses the inversion even by direct write', async () => {
    await expect(
      sql(
        `UPDATE "affiliate_settings"
            SET "accrualLookbackHours" = 1, "accrualIntervalHours" = 48
          WHERE "isSingleton" = true`,
      ),
    ).rejects.toThrow(/CHK_affiliate_settings_lookback_covers_interval/);
  });

  test('equal values are allowed', async ({ request }) => {
    const res = await updateSettings(request, admin.accessToken, {
      accrualIntervalHours: 24,
      accrualLookbackHours: 24,
    });
    expect(res.ok(), await res.text()).toBeTruthy();
  });

  test('payoutDayOfMonth is capped at 28 so February always fires', async ({
    request,
  }) => {
    expect(
      (
        await updateSettings(request, admin.accessToken, {
          payoutDayOfMonth: 29,
        })
      ).status(),
    ).toBe(400);
    expect(
      (
        await updateSettings(request, admin.accessToken, {
          payoutDayOfMonth: 31,
        })
      ).status(),
    ).toBe(400);
    expect(
      (
        await updateSettings(request, admin.accessToken, {
          payoutDayOfMonth: 28,
        })
      ).ok(),
    ).toBeTruthy();
  });

  test('a negative or zero commission rate is refused', async ({ request }) => {
    expect(
      (
        await updateSettings(request, admin.accessToken, {
          defaultCommissionRate: -5,
        })
      ).status(),
    ).toBe(400);
  });

  test('changing the accrual interval takes effect without a restart', async ({
    request,
  }) => {
    // The interval is baked into the BullMQ repeatable job, so the handler
    // re-registering it is the only thing that makes an admin edit real.
    const res = await updateSettings(request, admin.accessToken, {
      accrualIntervalHours: 12,
    });
    expect(res.ok(), await res.text()).toBeTruthy();

    const body = await payload<{ accrualIntervalHours: number }>(res);
    expect(body.accrualIntervalHours).toBe(12);
    expect(Number((await readSettings()).accrualIntervalHours)).toBe(12);
  });

  test('the read serves the stored programme rules as numbers, and reflects a write', async ({
    request,
  }) => {
    // The GET only ever had authz negatives and a bare 200 — the body that
    // the admin panel renders and edits against was never asserted. resetDb
    // pins the row at the shipped defaults, so every figure is known.
    //
    // One no-op write first: the service caches settings in-process for 30s
    // and resetDb only resets the row, so without the invalidation a stale
    // value from the previous test could answer this read.
    const invalidate = await updateSettings(request, admin.accessToken, {
      payoutDayOfMonth: 25,
    });
    expect(invalidate.ok(), await invalidate.text()).toBeTruthy();

    const res = await request.get('/admin/affiliate/settings', {
      headers: auth(admin.accessToken),
    });
    expect(res.status(), await res.text()).toBe(200);

    const body = await payload<Record<string, unknown>>(res);
    expect(body.isEnabled).toBe(false);
    expect(body.defaultCommissionType).toBe('percent');
    expect(body.defaultCommissionRate).toBe(10);
    expect(body.minPaidReferrals).toBe(10);
    expect(body.minPayoutAmount).toBe(1000);
    expect(body.payoutDayOfMonth).toBe(25);
    expect(body.cookieDurationDays).toBe(60);
    expect(body.accrualIntervalHours).toBe(48);
    expect(body.accrualLookbackHours).toBe(168);
    // The watermark is served (the panel shows "last run"), null before any
    // accrual; the singleton flag is internal and stays internal.
    expect(body.lastAccrualAt).toBeNull();
    expect(body).not.toHaveProperty('isSingleton');

    // The read is the same shape after a write — and the write is visible
    // through it, cache and all.
    const write = await updateSettings(request, admin.accessToken, {
      defaultCommissionRate: 12.5,
      minPayoutAmount: 500,
    });
    expect(write.ok(), await write.text()).toBeTruthy();

    const after = await payload<Record<string, unknown>>(
      await request.get('/admin/affiliate/settings', {
        headers: auth(admin.accessToken),
      }),
    );
    expect(after.defaultCommissionRate).toBe(12.5);
    expect(after.minPayoutAmount).toBe(500);
    expect(Number((await readSettings()).minPayoutAmount)).toBe(500);
  });

  test('the settings endpoints reject non-admins', async ({ request }) => {
    const customer = await createCustomer(request);
    const partner = await createPartner(request);

    for (const token of [customer.accessToken, partner.accessToken]) {
      const read = await request.get('/admin/affiliate/settings', {
        headers: auth(token),
      });
      expect([401, 403]).toContain(read.status());

      const write = await request.patch('/admin/affiliate/settings', {
        data: { isEnabled: true },
        headers: auth(token),
      });
      expect([401, 403]).toContain(write.status());
    }

    const anonymous = await request.get('/admin/affiliate/settings');
    expect([401, 403]).toContain(anonymous.status());
  });
});

/**
 * Companion to the lead-pipeline case in leads/pipeline.spec.ts: the same
 * self-healing shape, the same race. AffiliateSettingsService.get() is read on
 * nearly every affiliate code path — including the unauthenticated referral
 * click endpoint — so the accrual scheduler, the payout scheduler and public
 * traffic can all reach the "row missing" branch at the same instant on a
 * freshly restored database. save() made the loser throw on the unique index
 * and take the whole module down, which is the opposite of what the branch is
 * for.
 */
test.describe('affiliate settings singleton', () => {
  let admin: Customer;

  test.beforeAll(async ({ request }) => {
    await resetDb();
    admin = await createAdmin(request);
  });

  /**
   * Restoring the row is required, not polite. helpers/db.ts resets this
   * singleton with an UPDATE because the application self-heals it, so every
   * later spec file assumes it is there — and the first thing one of them does
   * is PATCH /admin/affiliate/settings, which findOneOrFail's on it.
   */
  test.afterAll(async () => {
    await sql(
      `INSERT INTO "affiliate_settings" ("isSingleton", "isEnabled")
       VALUES (true, false) ON CONFLICT DO NOTHING`,
    );
    await closeDb();
  });

  test('concurrent first reads all succeed when the row is missing', async ({
    request,
  }) => {
    // 30s here against the leads service's 10s: this cache is deliberately
    // longer-lived because get() sits on the referral click path. A warm cache
    // answers without touching the database, so the wait is what turns the
    // next read into a real first read.
    test.setTimeout(90_000);

    await sql('TRUNCATE TABLE "affiliate_settings"');
    await new Promise((resolve) => setTimeout(resolve, 31_000));

    const responses = await Promise.all(
      Array.from({ length: 6 }, () =>
        request.get('/admin/affiliate/settings', {
          headers: auth(admin.accessToken),
        }),
      ),
    );

    const statuses = responses.map((res) => res.status());
    expect(statuses.filter((status) => status !== 200)).toEqual([]);

    const rows = await sql<{ count: string }>(
      'SELECT COUNT(*)::text AS count FROM "affiliate_settings"',
    );
    expect(rows[0].count).toBe('1');
  });
});
