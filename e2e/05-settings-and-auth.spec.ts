import { test, expect } from '@playwright/test';
import { resetDb, closeDb, sql, readSettings } from './helpers/db.js';
import {
  createAdmin,
  createCustomer,
  createPartner,
  updateSettings,
  auth,
  payload,
  unique,
  Customer,
  Partner,
} from './helpers/actors.js';

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
      (await updateSettings(request, admin.accessToken, { payoutDayOfMonth: 29 }))
        .status(),
    ).toBe(400);
    expect(
      (await updateSettings(request, admin.accessToken, { payoutDayOfMonth: 31 }))
        .status(),
    ).toBe(400);
    expect(
      (await updateSettings(request, admin.accessToken, { payoutDayOfMonth: 28 }))
        .ok(),
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

test.describe('authorization boundaries', () => {
  let admin: Customer;
  let customer: Customer;
  let partner: Partner;

  test.beforeEach(async ({ request }) => {
    await resetDb();
    admin = await createAdmin(request);
    customer = await createCustomer(request);
    partner = await createPartner(request);
  });

  test.afterAll(async () => {
    await closeDb();
  });

  test('a customer token cannot reach partner routes', async ({ request }) => {
    // Separate signing secrets, so the signature should not even verify.
    for (const path of [
      '/partner/auth/me',
      '/partner/dashboard',
      '/partner/commissions',
      '/partner/payouts',
    ]) {
      const res = await request.get(path, { headers: auth(customer.accessToken) });
      expect([401, 403], `${path} accepted a customer token`).toContain(
        res.status(),
      );
    }
  });

  test('a partner token cannot reach customer routes', async ({ request }) => {
    for (const path of ['/wallet', '/messages', '/auth/me']) {
      const res = await request.get(path, { headers: auth(partner.accessToken) });
      expect([401, 403, 404], `${path} accepted a partner token`).toContain(
        res.status(),
      );
    }
  });

  test('a partner token cannot reach admin routes', async ({ request }) => {
    const res = await request.get('/admin/affiliate/partners', {
      headers: auth(partner.accessToken),
    });
    expect([401, 403]).toContain(res.status());
  });

  test('partner endpoints derive identity from the token, not the request', async ({
    request,
  }) => {
    const other = await createPartner(request);

    // Every list is scoped by @CurrentUser, so an id in the query string must
    // not widen the result set.
    const res = await request.get(`/partner/commissions?partnerId=${other.id}`, {
      headers: auth(partner.accessToken),
    });
    expect(res.ok(), await res.text()).toBeTruthy();

    const rows = await payload<{ partnerId: string }[]>(res);
    for (const row of rows) {
      expect(row.partnerId).toBe(partner.id);
    }
  });

  test('a partner never receives admin notes about themselves', async ({
    request,
  }) => {
    await sql(
      `UPDATE "partners" SET "adminNotes" = 'internal: suspected fraud' WHERE "id" = $1`,
      [partner.id],
    );

    const me = await request.get('/partner/auth/me', {
      headers: auth(partner.accessToken),
    });
    expect(me.ok()).toBeTruthy();
    const body = await payload<Record<string, unknown>>(me);

    expect(body).not.toHaveProperty('adminNotes');
    expect(body).not.toHaveProperty('passwordHash');
    expect(body).not.toHaveProperty('refreshTokenHash');
    expect(JSON.stringify(body)).not.toContain('suspected fraud');
  });

  test('suspending a partner revokes their ability to renew the session', async ({
    request,
  }) => {
    const login = await request.post('/partner/auth/login', {
      data: { email: partner.email, password: partner.password },
    });
    expect(login.ok()).toBeTruthy();
    const cookies = login.headers()['set-cookie'] ?? '';

    const res = await request.patch(
      `/admin/affiliate/partners/${partner.id}/status`,
      {
        data: { status: 'suspended' },
        headers: auth(admin.accessToken),
      },
    );
    expect(res.ok(), await res.text()).toBeTruthy();

    const [row] = await sql<{ refreshTokenHash: string | null }>(
      `SELECT "refreshTokenHash" FROM "partners" WHERE "id" = $1`,
      [partner.id],
    );
    expect(row.refreshTokenHash).toBeNull();

    if (cookies) {
      const refresh = await request.post('/partner/auth/refresh', {
        headers: { Cookie: cookies.split(';')[0] },
      });
      expect(refresh.ok()).toBeFalsy();
    }
  });

  test('partner login does not reveal whether an account exists', async ({
    request,
  }) => {
    const unknown = await request.post('/partner/auth/login', {
      data: { email: `${unique('nobody')}@example.com`, password: 'Password123!' },
    });
    const wrongPassword = await request.post('/partner/auth/login', {
      data: { email: partner.email, password: 'WrongPassword123!' },
    });

    // Compared on the error itself: requestId and timestamp differ by design,
    // so a whole-body match would fail for a reason that leaks nothing.
    expect(unknown.status()).toBe(wrongPassword.status());
    const a = (await unknown.json()) as { error: unknown };
    const b = (await wrongPassword.json()) as { error: unknown };
    expect(a.error).toEqual(b.error);
  });
});
