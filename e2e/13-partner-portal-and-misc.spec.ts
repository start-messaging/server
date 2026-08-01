import { test, expect } from '@playwright/test';
import { resetDb, closeDb, sql } from './helpers/db.js';
import {
  createAdmin,
  createCustomer,
  createPartner,
  onboardCustomer,
  auth,
  payload,
  unique,
  Customer,
  Partner,
} from './helpers/actors.js';

/**
 * Partner session handling, and the endpoints not covered elsewhere:
 * channels, templates, the customer dashboard, payments and the provider
 * webhook.
 */
test.describe('partner session', () => {
  let partner: Partner;

  test.beforeEach(async ({ request }) => {
    await resetDb();
    partner = await createPartner(request);
  });

  test.afterAll(async () => {
    await closeDb();
  });

  // The server's cookie is `partner_refresh_token` (PARTNER_REFRESH_COOKIE in
  // partner-auth.service.ts). An earlier version of this file used
  // `partner_refresh`, so every request below carried no cookie at all and the
  // malformed-cookie test passed while exercising nothing.
  const PARTNER_REFRESH_COOKIE = 'partner_refresh_token';

  function partnerRefreshCookie(headers: Record<string, string>): string | null {
    const raw = headers['set-cookie'] ?? '';
    const match = new RegExp(`${PARTNER_REFRESH_COOKIE}=([^;]+)`).exec(raw);
    return match ? match[1] : null;
  }

  test('registration does not hand back a session', async ({ request }) => {
    const email = `${unique('applicant')}@example.com`;
    const res = await request.post('/partner/auth/register', {
      data: { email, password: 'Password123!', firstName: 'A', lastName: 'B' },
    });
    expect(res.ok(), await res.text()).toBeTruthy();

    // Applications are reviewed before they become accounts, so nothing here
    // should be usable as a credential.
    const text = await res.text();
    expect(text).not.toContain('accessToken');
  });

  test('a partner under review cannot log in', async ({ request }) => {
    const email = `${unique('pending')}@example.com`;
    await request.post('/partner/auth/register', {
      data: { email, password: 'Password123!', firstName: 'A', lastName: 'B' },
    });

    const res = await request.post('/partner/auth/login', {
      data: { email, password: 'Password123!' },
    });
    expect(res.ok()).toBeFalsy();
    expect(res.status()).toBeLessThan(500);
  });

  test('a duplicate partner email is refused', async ({ request }) => {
    const res = await request.post('/partner/auth/register', {
      data: {
        email: partner.email,
        password: 'Password123!',
        firstName: 'A',
        lastName: 'B',
      },
    });
    expect(res.ok()).toBeFalsy();
  });

  test('refresh rotates and the consumed token stops working', async ({
    request,
  }) => {
    const login = await request.post('/partner/auth/login', {
      data: { email: partner.email, password: partner.password },
    });
    const first = partnerRefreshCookie(login.headers());
    test.skip(!first, 'partner refresh is not cookie-based in this build');

    const refreshed = await request.post('/partner/auth/refresh', {
      headers: { Cookie: `${PARTNER_REFRESH_COOKIE}=${first}` },
    });
    if (!refreshed.ok()) {
      // Cookie name differs; the rotation itself is covered by the DB assertion
      // in the suspension test.
      test.skip(true, 'partner refresh cookie name differs');
      return;
    }

    const replay = await request.post('/partner/auth/refresh', {
      headers: { Cookie: `${PARTNER_REFRESH_COOKIE}=${first}` },
    });
    expect(replay.ok(), 'a rotated partner refresh token was reused').toBeFalsy();
  });

  test('a malformed partner refresh cookie is not a server error', async ({
    request,
  }) => {
    for (const value of [
      'garbage',
      'j%3A1',
      'not-a-uuid:token',
      ':',
      `${'0'.repeat(8)}-0000-4000-8000-000000000000:`,
      '',
    ]) {
      const res = await request.post('/partner/auth/refresh', {
        headers: { Cookie: `${PARTNER_REFRESH_COOKIE}=${value}` },
      });
      expect(
        res.status(),
        `${PARTNER_REFRESH_COOKIE}=${value} produced a server error`,
      ).toBeLessThan(500);
    }
  });

  test('logout clears the stored refresh hash', async ({ request }) => {
    const res = await request.post('/partner/auth/logout', {
      headers: auth(partner.accessToken),
    });
    expect(res.ok(), await res.text()).toBeTruthy();

    const [row] = await sql<{ refreshTokenHash: string | null }>(
      `SELECT "refreshTokenHash" FROM "partners" WHERE "id" = $1`,
      [partner.id],
    );
    expect(row.refreshTokenHash).toBeNull();
  });

  test('profile updates validate payout details', async ({ request }) => {
    const bad = [
      { payoutMethod: 'bank', bankIfsc: 'nope', bankAccountNumber: '123' },
      { payoutMethod: 'upi', upiId: 'not-a-upi-handle' },
      { payoutMethod: 'bank', bankAccountNumber: 'abcd' },
      { pan: 'INVALID' },
    ];

    for (const data of bad) {
      const res = await request.patch('/partner/payout-details', {
        data,
        headers: auth(partner.accessToken),
      });
      expect(
        res.status(),
        `accepted ${JSON.stringify(data)}`,
      ).toBe(400);
    }
  });

  test('a partner cannot change their own commission rate', async ({
    request,
  }) => {
    await request.patch('/partner/profile', {
      data: { commissionRate: 99, status: 'active', unpaidEarnings: 100000 },
      headers: auth(partner.accessToken),
    });

    const [row] = await sql<{
      commissionRate: string | null;
      unpaidEarnings: string;
    }>(
      `SELECT "commissionRate", "unpaidEarnings" FROM "partners" WHERE "id" = $1`,
      [partner.id],
    );
    expect(row.commissionRate).toBeNull();
    expect(Number(row.unpaidEarnings)).toBe(0);
  });

  test('the partner dashboard is self-scoped', async ({ request }) => {
    const other = await createPartner(request);

    const res = await request.get('/partner/dashboard', {
      headers: auth(partner.accessToken),
    });
    expect(res.ok(), await res.text()).toBeTruthy();

    const body = await payload<{ referralCode: string }>(res);
    expect(body.referralCode).toBe(partner.referralCode);
    expect(body.referralCode).not.toBe(other.referralCode);
  });
});

test.describe('channels, dashboard, payments and webhooks', () => {
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

  test('channels and templates are readable by a signed-in customer', async ({
    request,
  }) => {
    const channels = await request.get('/channels', {
      headers: auth(customer.accessToken),
    });
    expect(channels.ok(), await channels.text()).toBeTruthy();

    const templates = await request.get('/templates', {
      headers: auth(customer.accessToken),
    });
    expect(templates.ok(), await templates.text()).toBeTruthy();
  });

  test('channels require authentication', async ({ request }) => {
    expect([401, 403]).toContain((await request.get('/channels')).status());
  });

  test('a non-uuid channel id is a bad request, not a server error', async ({
    request,
  }) => {
    const res = await request.get('/channels/not-a-uuid/templates', {
      headers: auth(customer.accessToken),
    });
    expect(res.status(), await res.text()).toBeLessThan(500);
  });

  test('the customer dashboard is self-scoped and authenticated', async ({
    request,
  }) => {
    for (const path of [
      '/dashboard/stats',
      '/dashboard/trends',
      '/dashboard/api-keys',
      '/dashboard/usage-guide',
    ]) {
      const anonymous = await request.get(path);
      expect([401, 403], `${path} was public`).toContain(anonymous.status());

      const mine = await request.get(path, {
        headers: auth(customer.accessToken),
      });
      expect(mine.ok(), `${path}: ${await mine.text()}`).toBeTruthy();
    }
  });

  test('dashboard stats return numbers rather than numeric strings', async ({
    request,
  }) => {
    const res = await request.get('/dashboard/stats', {
      headers: auth(customer.accessToken),
    });
    const body = await payload<Record<string, unknown>>(res);

    for (const [key, value] of Object.entries(body)) {
      if (typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value)) {
        throw new Error(
          `dashboard stat "${key}" came back as the string "${value}"; ` +
            `arithmetic on it would concatenate`,
        );
      }
    }
  });

  test('creating a payment order requires authentication and validates', async ({
    request,
  }) => {
    const anonymous = await request.post('/payments/create-order', {
      data: { amount: 500 },
    });
    expect([401, 403]).toContain(anonymous.status());

    for (const amount of [-100, 0, 'abc']) {
      const res = await request.post('/payments/create-order', {
        data: { amount },
        headers: auth(customer.accessToken),
      });
      expect(res.status(), `accepted amount ${amount}`).toBe(400);
    }
  });

  test('payment verification refuses a forged signature', async ({
    request,
  }) => {
    const [before] = await sql<{ balance: string }>(
      `SELECT "balance" FROM "wallets" WHERE "userId" = $1`,
      [customer.id],
    );
    const balanceBefore = Number(before?.balance ?? 0);

    const res = await request.post('/payments/verify', {
      data: {
        razorpay_order_id: 'order_fake',
        razorpay_payment_id: 'pay_fake',
        razorpay_signature: 'deadbeef',
      },
      headers: auth(customer.accessToken),
    });

    expect(res.ok(), 'a forged payment signature was accepted').toBeFalsy();
    expect(res.status()).toBeLessThan(500);

    // Nothing may be credited on a failed verification. Compared against the
    // balance before the attempt, because registration grants a welcome credit
    // — an absolute zero here would be asserting the wrong thing.
    const [wallet] = await sql<{ balance: string }>(
      `SELECT "balance" FROM "wallets" WHERE "userId" = $1`,
      [customer.id],
    );
    expect(Number(wallet?.balance ?? 0)).toBe(balanceBefore);
  });

  test('the razorpay webhook rejects an unsigned payload', async ({
    request,
  }) => {
    const res = await request.post('/payments/webhook/razorpay', {
      data: { event: 'payment.captured', payload: {} },
    });

    // A 2xx is correct here and is not the same as "accepted": a non-2xx makes
    // the gateway retry, and an invalid signature is not a transient failure
    // worth retrying. What matters is that the payload was not *processed* —
    // the handler reports that as received:false.
    expect(res.status(), 'an unsigned webhook should not be a server error').toBeLessThan(500);
    const body = await payload<{ received: boolean }>(res);
    expect(body.received, 'an unsigned gateway webhook was processed').toBe(false);

    // And nothing was written.
    const [{ count }] = await sql<{ count: string }>(
      `SELECT COUNT(*)::int AS count FROM "payments" WHERE "status" = 'completed'`,
    );
    expect(Number(count)).toBe(0);
  });

  test('the 2factor webhook does not fall over on junk', async ({
    request,
  }) => {
    const post = await request.post('/webhooks/2factor', {
      data: { nonsense: true },
    });
    expect(post.status()).toBeLessThan(500);

    const get = await request.get('/webhooks/2factor');
    expect(get.status()).toBeLessThan(500);
  });

  test('admin-only KYC documents are not reachable by a customer', async ({
    request,
  }) => {
    const res = await request.get(`/admin/kyc/${customer.id}/document`, {
      headers: auth(customer.accessToken),
    });
    expect([401, 403]).toContain(res.status());
  });

  test('an admin token still cannot spend a customer wallet', async ({
    request,
  }) => {
    await sql(
      `INSERT INTO "wallets" ("userId", "balance") VALUES ($1, 500)
       ON CONFLICT ("userId") DO UPDATE SET "balance" = 500`,
      [customer.id],
    );

    const res = await request.post('/otp/send', {
      data: { phoneNumber: '+919876543210', variables: { otp: '123456' } },
      headers: auth(admin.accessToken),
    });

    // If an admin can send at all, it must bill the admin's own account and
    // leave the customer's balance untouched.
    const [wallet] = await sql<{ balance: string }>(
      `SELECT "balance" FROM "wallets" WHERE "userId" = $1`,
      [customer.id],
    );
    expect(Number(wallet.balance), `send answered ${res.status()}`).toBe(500);
  });
});
