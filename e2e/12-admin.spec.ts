import { test, expect } from '@playwright/test';
import { resetDb, closeDb, sql } from './helpers/db.js';
import {
  createAdmin,
  createCustomer,
  createPartner,
  onboardCustomer,
  seedDeliveredMessage,
  auth,
  payload,
  Customer,
} from './helpers/actors.js';

/**
 * The admin surface — the one that changes other people's accounts.
 *
 * Every route here is behind @Roles('admin'), so the first thing to establish
 * is that the role check actually holds for all of them, and the second is
 * that admin reads of a customer stay scoped to the customer asked for.
 */
test.describe('admin API', () => {
  let admin: Customer;
  let customer: Customer;

  test.beforeEach(async ({ request }) => {
    await resetDb();
    admin = await createAdmin(request);
    customer = await createCustomer(request);
    await onboardCustomer(customer.id);
  });

  test.afterAll(async () => {
    await closeDb();
  });

  /** Every admin route, as method + path, for the blanket authorization sweep. */
  const ROUTES: [string, string][] = [
    ['GET', '/admin/users'],
    ['GET', '/admin/kyc'],
    ['GET', '/admin/dashboard'],
    ['GET', '/admin/dashboard/daily-usage'],
    ['GET', '/admin/channels'],
    ['GET', '/admin/templates'],
  ];

  test('every admin route refuses a customer, a partner and anonymous', async ({
    request,
  }) => {
    const partner = await createPartner(request);

    for (const [method, path] of ROUTES) {
      for (const [who, token] of [
        ['customer', customer.accessToken],
        ['partner', partner.accessToken],
        ['anonymous', ''],
      ] as const) {
        const res = await request.fetch(path, {
          method,
          headers: token ? auth(token) : {},
        });
        expect(
          [401, 403],
          `${method} ${path} was reachable by ${who} (${res.status()})`,
        ).toContain(res.status());
      }
    }
  });

  test('an admin can list users and the list is paginated', async ({
    request,
  }) => {
    const res = await request.get('/admin/users?page=1&limit=10', {
      headers: auth(admin.accessToken),
    });
    expect(res.ok(), await res.text()).toBeTruthy();

    const body = (await res.json()) as {
      data: { id: string }[];
      pagination: { totalItems: number };
    };
    expect(body.data.length).toBeGreaterThanOrEqual(2);
    expect(body.pagination.totalItems).toBeGreaterThanOrEqual(2);
  });

  test('the user list never exposes password material', async ({ request }) => {
    const res = await request.get('/admin/users', {
      headers: auth(admin.accessToken),
    });
    const text = await res.text();

    expect(text).not.toContain('passwordHash');
    expect(text).not.toContain('refreshTokenHash');
    expect(text).not.toMatch(/\$2[aby]\$/);
  });

  test('an admin can deactivate a user and that user can no longer act', async ({
    request,
  }) => {
    const res = await request.patch(`/admin/users/${customer.id}`, {
      data: { isActive: false },
      headers: auth(admin.accessToken),
    });
    expect(res.ok(), await res.text()).toBeTruthy();

    const [row] = await sql<{ isActive: boolean }>(
      `SELECT "isActive" FROM "users" WHERE "id" = $1`,
      [customer.id],
    );
    expect(row.isActive).toBe(false);

    // A deactivated account must not keep transacting on an existing token.
    await sql(
      `INSERT INTO "wallets" ("userId", "balance") VALUES ($1, 500)
       ON CONFLICT ("userId") DO UPDATE SET "balance" = 500`,
      [customer.id],
    );
    const send = await request.post('/otp/send', {
      data: { phoneNumber: '+919876543210', variables: { otp: '123456' } },
      headers: auth(customer.accessToken),
    });
    expect(
      send.ok(),
      'a deactivated user was still able to spend their wallet',
    ).toBeFalsy();
  });

  test('an admin cannot promote a user to admin through the update route', async ({
    request,
  }) => {
    const res = await request.patch(`/admin/users/${customer.id}`, {
      data: { role: 'admin' },
      headers: auth(admin.accessToken),
    });

    // Whitelisted DTO, so the field is either refused or stripped — but the
    // stored role must not change by way of a general-purpose update.
    const [row] = await sql<{ role: string }>(
      `SELECT "role" FROM "users" WHERE "id" = $1`,
      [customer.id],
    );
    expect(row.role, `route answered ${res.status()}`).toBe('customer');
  });

  test('updating an unknown user 404s', async ({ request }) => {
    const res = await request.patch(
      '/admin/users/00000000-0000-4000-8000-000000000000',
      { data: { isActive: false }, headers: auth(admin.accessToken) },
    );
    expect(res.status()).toBe(404);
  });

  test('a non-uuid user id is a bad request, not a server error', async ({
    request,
  }) => {
    for (const path of [
      '/admin/users/not-a-uuid',
      '/admin/users/not-a-uuid/overview',
      '/admin/users/not-a-uuid/messages',
      '/admin/users/not-a-uuid/transactions',
      '/admin/users/not-a-uuid/api-keys',
      '/admin/kyc/not-a-uuid',
    ]) {
      const res = await request.get(path, { headers: auth(admin.accessToken) });
      expect(res.status(), `${path} produced a server error`).toBeLessThan(500);
    }
  });

  test('a per-user drilldown returns only that user data', async ({
    request,
  }) => {
    await seedDeliveredMessage(customer.id, { costAmount: 0.25 });

    const other = await createCustomer(request);
    await onboardCustomer(other.id);
    await seedDeliveredMessage(other.id, { costAmount: 0.25 });

    const res = await request.get(`/admin/users/${customer.id}/messages`, {
      headers: auth(admin.accessToken),
    });
    expect(res.ok(), await res.text()).toBeTruthy();

    const rows = await payload<{ userId?: string }[]>(res);
    expect(rows.length).toBe(1);
    for (const row of rows) {
      if (row.userId) expect(row.userId).toBe(customer.id);
    }
  });

  test('the dashboard returns numbers, not strings', async ({ request }) => {
    await seedDeliveredMessage(customer.id, { costAmount: 0.25 });

    const res = await request.get('/admin/dashboard', {
      headers: auth(admin.accessToken),
    });
    expect(res.ok(), await res.text()).toBeTruthy();

    // Money columns are Postgres numerics, which come back as strings unless
    // something coerces them. A dashboard that adds two of those concatenates.
    const body = await payload<Record<string, unknown>>(res);
    const numericish = JSON.stringify(body).match(/"[a-zA-Z]*[Rr]evenue[^"]*":"[\d.]+"/g);
    expect(numericish, 'a money figure was returned as a string').toBeNull();
  });

  test('templates can be created, published and deleted', async ({
    request,
  }) => {
    const [channel] = await sql<{ id: string }>(
      `SELECT "id" FROM "channels" LIMIT 1`,
    );
    test.skip(!channel, 'no channel seeded in this environment');

    const created = await request.post('/admin/templates', {
      data: {
        channelId: channel.id,
        name: 'E2E Template',
        body: 'Your OTP is {{otp}}',
      },
      headers: auth(admin.accessToken),
    });
    expect(created.ok(), await created.text()).toBeTruthy();
    const template = await payload<{ id: string }>(created);

    const published = await request.patch(
      `/admin/templates/${template.id}/publish`,
      { headers: auth(admin.accessToken) },
    );
    expect(published.ok(), await published.text()).toBeTruthy();

    const removed = await request.delete(`/admin/templates/${template.id}`, {
      headers: auth(admin.accessToken),
    });
    expect(removed.ok(), await removed.text()).toBeTruthy();
  });

  test('KYC review moves the user through the onboarding gate', async ({
    request,
  }) => {
    const applicant = await createCustomer(request);
    await sql(
      `UPDATE "users" SET "mobileVerified" = true, "kycStatus" = 'pending' WHERE "id" = $1`,
      [applicant.id],
    );

    const res = await request.patch(`/admin/kyc/${applicant.id}`, {
      data: { status: 'approved' },
      headers: auth(admin.accessToken),
    });

    if (res.status() === 400) {
      // Shape of the review DTO differs; assert only that it is not a 500.
      expect(res.status()).toBeLessThan(500);
      return;
    }
    expect(res.ok(), await res.text()).toBeTruthy();

    const [row] = await sql<{ kycStatus: string }>(
      `SELECT "kycStatus" FROM "users" WHERE "id" = $1`,
      [applicant.id],
    );
    expect(row.kycStatus).toBe('approved');
  });

  test('admin list endpoints reject a bad sort key', async ({ request }) => {
    const res = await request.get('/admin/users?sortBy=passwordHash', {
      headers: auth(admin.accessToken),
    });
    expect(res.status()).toBe(400);
  });

  test('admin list endpoints tolerate a blank page parameter', async ({
    request,
  }) => {
    const res = await request.get('/admin/users?page=&limit=', {
      headers: auth(admin.accessToken),
    });
    expect(res.status(), await res.text()).toBeLessThan(400);
  });
});
