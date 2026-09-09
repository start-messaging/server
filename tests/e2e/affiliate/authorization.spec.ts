import { test, expect } from '@playwright/test';
import { resetDb, closeDb, sql } from '../helpers/db.js';
import {
  createAdmin,
  createCustomer,
  createPartner,
  auth,
  payload,
  unique,
  Customer,
  Partner,
} from '../helpers/actors.js';

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
      const res = await request.get(path, {
        headers: auth(customer.accessToken),
      });
      expect([401, 403], `${path} accepted a customer token`).toContain(
        res.status(),
      );
    }
  });

  test('a partner token cannot reach customer routes', async ({ request }) => {
    for (const path of ['/wallet', '/messages', '/auth/me']) {
      const res = await request.get(path, {
        headers: auth(partner.accessToken),
      });
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
    const res = await request.get(
      `/partner/commissions?partnerId=${other.id}`,
      {
        headers: auth(partner.accessToken),
      },
    );
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

  test('suspending a partner invalidates their existing access token', async ({
    request,
  }) => {
    // Before: clearing the refresh hash stopped them renewing, but the access
    // token already in hand stayed good for its full hour — long enough for a
    // partner suspended for fraud to rewrite the bank details a later
    // reinstatement would pay into.
    const before = await request.get('/partner/auth/me', {
      headers: auth(partner.accessToken),
    });
    expect(before.ok(), await before.text()).toBeTruthy();

    await sql(`UPDATE "partners" SET "status" = 'suspended' WHERE "id" = $1`, [
      partner.id,
    ]);

    for (const path of [
      '/partner/auth/me',
      '/partner/dashboard',
      '/partner/commissions',
      '/partner/payouts',
    ]) {
      const res = await request.get(path, {
        headers: auth(partner.accessToken),
      });
      expect([401, 403], `${path} still served a suspended partner`).toContain(
        res.status(),
      );
    }

    // And they cannot change where money would be sent.
    const write = await request.patch('/partner/payout-details', {
      data: { payoutMethod: 'upi', upiId: 'attacker@okaxis' },
      headers: auth(partner.accessToken),
    });
    expect([401, 403]).toContain(write.status());
  });

  test('a rejected partner is likewise cut off immediately', async ({
    request,
  }) => {
    await sql(`UPDATE "partners" SET "status" = 'rejected' WHERE "id" = $1`, [
      partner.id,
    ]);
    const res = await request.get('/partner/auth/me', {
      headers: auth(partner.accessToken),
    });
    expect([401, 403]).toContain(res.status());
  });

  test('partner login does not reveal whether an account exists', async ({
    request,
  }) => {
    const unknown = await request.post('/partner/auth/login', {
      data: {
        email: `${unique('nobody')}@example.com`,
        password: 'Password123!',
      },
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
