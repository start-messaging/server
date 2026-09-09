import { test, expect } from '@playwright/test';
import { resetDb, closeDb, sql } from '../helpers/db.js';
import {
  createAdmin,
  createCustomer,
  onboardCustomer,
  auth,
  payload,
  Customer,
} from '../helpers/actors.js';
import { seedLedger } from '../helpers/wallet.js';

/**
 * The endpoints not covered elsewhere: channels, templates, the customer
 * dashboard, payments and the provider webhook.
 */
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
    expect(
      res.status(),
      'an unsigned webhook should not be a server error',
    ).toBeLessThan(500);
    const body = await payload<{ received: boolean }>(res);
    expect(body.received, 'an unsigned gateway webhook was processed').toBe(
      false,
    );

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
    await seedLedger(customer.id, {
      to: 500,
      description: 'e2e fixture adjustment',
    });

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
