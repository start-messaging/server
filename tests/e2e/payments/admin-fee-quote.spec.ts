import { test, expect } from '@playwright/test';
import { resetDb, closeDb } from '../helpers/db.js';
import {
  createAdmin,
  createCustomer,
  onboardCustomer,
  auth,
  payload,
  Customer,
} from '../helpers/actors.js';
import { errorOf } from './helpers.js';

/**
 * The admin custom-payment quote: `GET /admin/payments/fee-quote`.
 *
 * It exists for payments raised or received outside the app. `credit` answers
 * "what should the customer be asked to pay?" and `paid` answers "what do I
 * credit for what they paid?". The arithmetic itself is owned by
 * payments/convenience-fee.spec.ts; this file is about who may ask and what the
 * endpoint refuses. The test environment runs the shipped `simple` 2% rule.
 */
test.describe('payments: the admin custom-payment quote', () => {
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

  const get = (
    request: import('@playwright/test').APIRequestContext,
    token: string | null,
    query: string,
  ) =>
    request.get(`/admin/payments/fee-quote${query}`, {
      headers: token ? auth(token) : {},
    });

  test('an admin gets the charge for a credit, and the credit for a charge', async ({
    request,
  }) => {
    const forward = await get(request, admin.accessToken, '?credit=1000');
    expect(forward.status(), await forward.text()).toBe(200);
    expect(await payload(forward)).toEqual({
      mode: 'simple',
      amount: 1000,
      convenienceFee: 20,
      chargedAmount: 1020,
    });

    const back = await get(request, admin.accessToken, '?paid=1020');
    expect(back.status(), await back.text()).toBe(200);
    expect(await payload(back)).toEqual({
      mode: 'simple',
      amount: 1000,
      convenienceFee: 20,
      chargedAmount: 1020,
    });
  });

  test('it is the same figure the customer is quoted in the app', async ({
    request,
  }) => {
    // The point of the screen is that a custom payment costs what an app
    // top-up would, so the two must never drift.
    const app = await request.get('/payments/fee-quote?amount=2500', {
      headers: auth(customer.accessToken),
    });
    const adminSide = await get(request, admin.accessToken, '?credit=2500');
    const { mode: _mode, ...rest } = await payload<Record<string, unknown>>(
      adminSide,
    );
    expect(rest).toEqual(await payload(app));
  });

  test('only an admin may ask', async ({ request }) => {
    const anon = await get(request, null, '?credit=1000');
    expect(anon.status(), await anon.text()).toBe(401);

    const asCustomer = await get(request, customer.accessToken, '?credit=1000');
    expect(asCustomer.status(), await asCustomer.text()).toBe(403);
  });

  test('exactly one of credit and paid is required', async ({ request }) => {
    for (const query of ['', '?credit=1000&paid=1020']) {
      const res = await get(request, admin.accessToken, query);
      expect(res.status(), `"${query}"`).toBe(400);
      expect((await errorOf(res)).message).toBe(
        'Send exactly one of credit or paid',
      );
    }
  });

  test('nonsense, zero, negative and oversized values are refused, not computed', async ({
    request,
  }) => {
    for (const query of [
      '?credit=abc',
      '?credit=',
      '?credit=0',
      '?credit=-5',
      '?credit=NaN',
      '?credit=Infinity',
      '?credit=1000001',
      '?paid=0',
      '?paid=-1',
      '?paid=1e9',
    ]) {
      const res = await get(request, admin.accessToken, query);
      expect(res.status(), `"${query}" was accepted`).toBe(400);
    }
  });

  test('a payment smaller than the fee still credits nothing it should not', async ({
    request,
  }) => {
    const res = await get(request, admin.accessToken, '?paid=0.01');
    expect(res.status(), await res.text()).toBe(200);
    const body = await payload<{ amount: number; chargedAmount: number }>(res);
    expect(body.chargedAmount).toBeLessThanOrEqual(0.01);
    expect(body.amount).toBeLessThanOrEqual(0.01);
  });
});
