import { test, expect } from '@playwright/test';
import { resetDb, closeDb } from '../helpers/db.js';
import {
  createCustomer,
  createPartner,
  onboardCustomer,
  auth,
  payload,
  Customer,
} from '../helpers/actors.js';
import { errorOf, quote } from './helpers.js';

/**
 * The fee quote: `GET /payments/fee-quote`.
 *
 * payments/convenience-fee.spec.ts owns the fee arithmetic and the reconciliation
 * constraint; this file does not repeat either. What it goes after instead is
 * who may call, and what the endpoint refuses.
 */

test.describe('payments: the fee quote', () => {
  let customer: Customer;

  test.beforeEach(async ({ request }) => {
    await resetDb();
    customer = await createCustomer(request);
    await onboardCustomer(customer.id);
  });

  test.afterAll(async () => {
    await closeDb();
  });

  test('the quote is not readable without a session', async ({ request }) => {
    // It carries no @Public(), unlike the webhook, so the surcharge a customer
    // will be charged is not something an anonymous caller can enumerate.
    const anonymous = await request.get('/payments/fee-quote?amount=1000');
    expect(anonymous.status(), await anonymous.text()).toBe(401);
    expect((await errorOf(anonymous)).code).toBe('UNAUTHORIZED');

    for (const token of ['not.a.jwt', 'Bearer', `${customer.accessToken}x`]) {
      const res = await request.get('/payments/fee-quote?amount=1000', {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(res.status(), `token "${token.slice(0, 12)}" was accepted`).toBe(
        401,
      );
    }
  });

  test('a partner session cannot read the customer fee quote', async ({
    request,
  }) => {
    // Partner tokens are signed with PARTNER_JWT_SECRET, deliberately distinct
    // from the customer key, so a partner portal session must be worthless
    // against a customer money route.
    const partner = await createPartner(request);
    const res = await quote(request, partner.accessToken, '?amount=1000');

    expect(res.status(), await res.text()).toBe(401);
    expect((await errorOf(res)).code).toBe('UNAUTHORIZED');
  });

  test('an unfinished signup can raise an order but cannot see what it costs', async ({
    request,
  }) => {
    // create-order and verify carry @SkipOnboarding(); fee-quote does not. So
    // the one route that only *reads* a number is the one the guard blocks,
    // while the two that move money are open. Pinned rather than asserted as
    // correct: whichever way this is resolved, it should be resolved on
    // purpose.
    const fresh = await createCustomer(request);

    const quoted = await quote(request, fresh.accessToken, '?amount=1000');
    expect(quoted.status(), await quoted.text()).toBe(403);
    const blocked = await errorOf(quoted);
    expect(blocked.message).toBe('Mobile verification required');
    // OnboardingGuard raises `errorCode: ONBOARDING_INCOMPLETE`, but the
    // exception filter reads `code`, so the client sees a bare FORBIDDEN.
    expect(blocked.code).toBe('FORBIDDEN');

    // Same account, the route that actually charges a card: it gets past the
    // guard and dies in the DTO instead.
    const ordered = await request.post('/payments/create-order', {
      data: { amount: 1 },
      headers: auth(fresh.accessToken),
    });
    expect(ordered.status(), await ordered.text()).toBe(400);
    expect((await errorOf(ordered)).code).toBe('VALIDATION_ERROR');
  });

  test('an amount that is missing, empty or not a positive number is refused', async ({
    request,
  }) => {
    const cases: [string, string][] = [
      ['', 'no amount at all'],
      ['?amount=', 'an empty amount'],
      ['?amount=abc', 'a word'],
      ['?amount=0', 'zero'],
      ['?amount=-100', 'a negative amount'],
      ['?amount=1000abc', 'a number with a suffix'],
      ['?amount=NaN', 'the string NaN'],
      // Number('1e309') overflows to Infinity, which is not a price. It has to
      // be caught here rather than reaching the gross-up arithmetic.
      ['?amount=1e309', 'an amount that overflows to Infinity'],
      // A scalar was expected; express hands the handler an array.
      ['?amount=1&amount=2', 'the parameter twice'],
      [`?amount=${encodeURIComponent('₹1000')}`, 'a currency symbol'],
    ];

    for (const [query, description] of cases) {
      const res = await quote(request, customer.accessToken, query);
      expect(res.status(), `${description} was quoted`).toBe(400);
      const error = await errorOf(res);
      // Raised by the service, not the DTO — the two are distinguishable, and
      // a client that keys off the code should not have to guess which.
      expect(error.code, description).toBe('INVALID_INPUT');
      expect(error.message).toBe('amount must be a positive number');
    }
  });

  test('the quote returns the exact figures the order will be raised for', async ({
    request,
  }) => {
    // The arithmetic itself belongs to payments/convenience-fee; what is asserted
    // here is that the endpoint hands back all three numbers, reconciled, so
    // the checkout can show the surcharge before the customer commits.
    const res = await quote(request, customer.accessToken, '?amount=1000');
    expect(res.status(), await res.text()).toBe(200);

    const body = await payload<{
      amount: number;
      convenienceFee: number;
      chargedAmount: number;
    }>(res);
    expect(body).toEqual({
      amount: 1000,
      convenienceFee: 20,
      chargedAmount: 1020,
    });
    expect(body.amount + body.convenienceFee).toBe(body.chargedAmount);

    // Numbers, not numeric strings: a checkout that adds these would otherwise
    // concatenate them.
    for (const [key, value] of Object.entries(body)) {
      expect(typeof value, `${key} came back as ${typeof value}`).toBe(
        'number',
      );
    }
  });

  test('surrounding whitespace in the amount is tolerated', async ({
    request,
  }) => {
    // A checkout that pastes "  1000  " out of an input box gets a quote
    // rather than an error, and the same quote as the trimmed value.
    const res = await quote(
      request,
      customer.accessToken,
      `?amount=${encodeURIComponent('  1000  ')}`,
    );
    expect(res.status(), await res.text()).toBe(200);
    expect(await payload(res)).toEqual({
      amount: 1000,
      convenienceFee: 20,
      chargedAmount: 1020,
    });
  });

  test('the quote will price a top-up too small to actually order', async ({
    request,
  }) => {
    // `quote()` enforces only "positive"; CreateOrderDto enforces ₹1,000. So
    // the endpoint whose whole purpose is to tell the customer what a top-up
    // costs will happily price one the next request refuses. Pinned so the
    // floor moving into the quote is a deliberate change.
    const quoted = await quote(request, customer.accessToken, '?amount=1');
    expect(quoted.status(), await quoted.text()).toBe(200);
    expect(await payload(quoted)).toEqual({
      amount: 1,
      convenienceFee: 0.02,
      chargedAmount: 1.02,
    });

    const ordered = await request.post('/payments/create-order', {
      data: { amount: 1 },
      headers: auth(customer.accessToken),
    });
    expect(ordered.status(), await ordered.text()).toBe(400);
  });
});
