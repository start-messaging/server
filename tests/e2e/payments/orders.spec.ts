import { test, expect } from '@playwright/test';
import { resetDb, closeDb, sql } from '../helpers/db.js';
import {
  createAdmin,
  createCustomer,
  createPartner,
  onboardCustomer,
  payload,
  Customer,
} from '../helpers/actors.js';
import {
  balanceOf,
  checkoutSignature,
  complaints,
  errorOf,
  order,
  paymentCountFor,
  postVerify,
} from './helpers.js';
import { createKey } from '../api-keys/helpers.js';

/**
 * Creating an order: `POST /payments/create-order`.
 *
 * **No test may reach Razorpay.** `POST /payments/create-order` calls the
 * live orders API, and this environment holds dummy credentials, so every
 * order-creation case here is one that is refused *before* the gateway is
 * touched: by the guard, by the DTO, or by the currency lookup in
 * `PaymentGatewayFactory`. An amount large enough to pass `@Min` may only
 * be sent when something later in `createOrder` — today, only the
 * unsupported-currency lookup — refuses it before `gateway.createOrder`.
 *
 * Every amount used here is one that never reaches the gateway.
 *
 * An amount that passes validation reaches Razorpay's live orders API, so
 * with one exception every case below is under the minimum, and the
 * assertions are about what was refused and what was not written rather than
 * about a returned order. The exception is the unsupported-currency test,
 * which passes the DTO on purpose and is stopped by the factory instead —
 * `createOrder` resolves the gateway from the wallet before it calls it.
 *
 * The SUCCESS path lives in the second describe below, behind the
 * PAYMENTS_FAKE_GATEWAY seam (.env.e2e, double-locked on NODE_ENV=test):
 * order creation is answered locally while signature verification stays the
 * real HMAC code, so a raised order can be settled for real. The refusal
 * tests above still never reach any gateway at all.
 */

test.describe('payments: creating an order', () => {
  let customer: Customer;

  test.beforeEach(async ({ request }) => {
    await resetDb();
    customer = await createCustomer(request);
    await onboardCustomer(customer.id);
  });

  test.afterAll(async () => {
    await closeDb();
  });

  test('an order cannot be raised without a customer session', async ({
    request,
  }) => {
    const anonymous = await request.post('/payments/create-order', {
      data: { amount: 1 },
    });
    expect(anonymous.status(), await anonymous.text()).toBe(401);
    expect((await errorOf(anonymous)).code).toBe('UNAUTHORIZED');

    const partner = await createPartner(request);
    const asPartner = await order(request, partner.accessToken, { amount: 1 });
    expect(asPartner.status(), await asPartner.text()).toBe(401);

    const forged = await request.post('/payments/create-order', {
      data: { amount: 1 },
      headers: { Authorization: `Bearer ${customer.accessToken}tampered` },
    });
    expect(forged.status(), await forged.text()).toBe(401);

    // Not one row was written by any of the three.
    const [{ count }] = await sql<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM "payments"`,
    );
    expect(Number(count)).toBe(0);
  });

  test('an admin reaches the customer order route rather than being refused', async ({
    request,
  }) => {
    // There is no @Roles on this controller, so an admin session is a customer
    // session as far as payments are concerned — it tops up the admin's own
    // wallet. Asserted as a 400 (the DTO) rather than a 401/403 (a guard),
    // which is what shows the request got all the way through.
    const admin = await createAdmin(request);
    const res = await order(request, admin.accessToken, { amount: 1 });

    expect(res.status(), await res.text()).toBe(400);
    expect((await errorOf(res)).code).toBe('VALIDATION_ERROR');
  });

  test('the amount must be a number, and at least the minimum top-up', async ({
    request,
  }) => {
    const cases: [unknown, string][] = [
      [undefined, 'a missing amount'],
      [null, 'a null amount'],
      ['', 'an empty string'],
      ['abc', 'a word'],
      [0, 'zero'],
      [-1000, 'a negative amount'],
      [1, 'a rupee'],
      [999.99, 'a fraction under the minimum'],
      [true, 'a boolean'],
      [[1], 'an array where a scalar belongs'],
      [{}, 'an object'],
      // JSON has no Infinity; the string form is what a client would send, and
      // Number('1e309') is Infinity, which @IsNumber refuses outright.
      ['1e309', 'an amount that overflows to Infinity'],
      ['NaN', 'the string NaN'],
    ];

    for (const [amount, description] of cases) {
      const res = await order(
        request,
        customer.accessToken,
        amount === undefined ? {} : { amount },
      );
      expect(res.status(), `${description} was accepted`).toBe(400);
      expect((await errorOf(res)).code, description).toBe('VALIDATION_ERROR');
    }

    expect(
      await paymentCountFor(customer.id),
      'a refused order still wrote a payment row',
    ).toBe(0);
  });

  test('the refusal names the real minimum, not a development one', async ({
    request,
  }) => {
    // `@Min(NODE_ENV === 'development' ? 10 : 1000)` is resolved once, at
    // import time, from the environment the server booted with. If a deploy
    // ever came up thinking it was development, ₹10 top-ups would be orderable
    // in production — and this assertion is how that would be noticed.
    const res = await order(request, customer.accessToken, { amount: 1 });
    expect(await complaints(res)).toContain(
      'amount must not be less than 1000',
    );
  });

  test('a numeric string amount is coerced, not rejected', async ({
    request,
  }) => {
    // The global pipe runs with `enableImplicitConversion`, so a checkout that
    // posts "1500" out of a text input raises a real ₹1,500 order rather than
    // failing. Worth pinning: it means the type of `amount` on the wire is not
    // actually enforced, and only the minimum stands between a string and an
    // order.
    const res = await order(request, customer.accessToken, { amount: '1' });
    expect(res.status(), await res.text()).toBe(400);

    const said = await complaints(res);
    expect(said).toContain('amount must not be less than 1000');
    expect(said, 'a numeric string was refused as a type error').not.toContain(
      'must be a number',
    );
  });

  test('an order cannot be raised in a currency the platform does not support', async ({
    request,
  }) => {
    // The gateway is chosen from the wallet's currency, not from the request.
    // A wallet in a currency with no configured gateway has to be refused at
    // the factory — before an order is raised, and before a row is written.
    await sql(`UPDATE "wallets" SET "currency" = 'USD' WHERE "userId" = $1`, [
      customer.id,
    ]);
    const before = await balanceOf(customer.id);

    const res = await order(request, customer.accessToken, { amount: 1000 });
    expect(res.status(), await res.text()).toBe(400);

    const error = await errorOf(res);
    expect(error.code).toBe('INVALID_INPUT');
    expect(error.message).toBe('Unsupported currency: USD');

    expect(
      await paymentCountFor(customer.id),
      'a payment row was written for an order that was never raised',
    ).toBe(0);
    expect(await balanceOf(customer.id)).toBe(before);
  });
});

/**
 * The success path, via the fake gateway (PAYMENTS_FAKE_GATEWAY, .env.e2e).
 *
 * The fake answers ORDER CREATION locally with a Razorpay-shaped order and
 * delegates everything else — public key, checkout signature, webhook HMAC —
 * to the real gateway code, so what these tests drive is the genuine service
 * path: fee arithmetic, the persisted row, and settlement.
 */
test.describe('payments: creating an order — the fake-gateway success path', () => {
  let customer: Customer;

  test.beforeEach(async ({ request }) => {
    await resetDb();
    customer = await createCustomer(request);
    await onboardCustomer(customer.id);
  });

  test.afterAll(async () => {
    await closeDb();
  });

  interface OrderResponse {
    paymentId: string;
    gatewayOrderId: string;
    amount: number;
    convenienceFee: number;
    chargedAmount: number;
    currency: string;
    gatewayKey: string;
  }

  test('a valid order persists a created row that reconciles to the paisa', async ({
    request,
  }) => {
    const res = await order(request, customer.accessToken, { amount: 1000 });
    expect(res.status(), await res.text()).toBe(201);

    // The contract the checkout consumes: the gateway order id it hands to
    // Razorpay Checkout, and the full disclosed breakdown, as numbers.
    const body = await payload<OrderResponse>(res);
    expect(body.gatewayOrderId).toMatch(/^order_fake_[0-9a-f]{12}$/);
    expect(body.amount).toBe(1000);
    expect(body.convenienceFee).toBe(20); // 2% simple — the shipped default
    expect(body.chargedAmount).toBe(1020);
    expect(body.currency).toBe('INR');
    expect(typeof body.gatewayKey).toBe('string');
    expect(body.gatewayKey.length).toBeGreaterThan(0);

    const rows = await sql<{
      userId: string;
      status: string;
      gateway: string;
      gatewayOrderId: string;
      amount: string;
      convenienceFee: string;
      chargedAmount: string;
      idempotencyKey: string | null;
    }>(
      `SELECT "userId", "status", "gateway", "gatewayOrderId", "amount",
              "convenienceFee", "chargedAmount", "idempotencyKey"
         FROM "payments"`,
    );
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.userId).toBe(customer.id);
    expect(row.status).toBe('created');
    expect(row.gateway).toBe('razorpay');
    expect(row.gatewayOrderId).toBe(body.gatewayOrderId);
    // The CHK_payments_charged_reconciles arithmetic, read back as stored:
    // credited + fee = charged, exactly.
    expect(Number(row.amount)).toBe(1000);
    expect(Number(row.convenienceFee)).toBe(20);
    expect(Number(row.chargedAmount)).toBe(
      Number(row.amount) + Number(row.convenienceFee),
    );
    expect(row.idempotencyKey).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  test('an order raised through the fake gateway settles through the real verification path', async ({
    request,
  }) => {
    // End to end: the fake only replaced order creation, so the signature
    // check and the wallet credit here are the same code a production
    // checkout goes through.
    const res = await order(request, customer.accessToken, { amount: 1000 });
    expect(res.status(), await res.text()).toBe(201);
    const body = await payload<OrderResponse>(res);
    const before = await balanceOf(customer.id);

    const paymentId = `pay_${body.gatewayOrderId}`;
    const verify = await postVerify(request, customer.accessToken, {
      razorpayOrderId: body.gatewayOrderId,
      razorpayPaymentId: paymentId,
      razorpaySignature: checkoutSignature(body.gatewayOrderId, paymentId),
    });
    expect(verify.ok(), await verify.text()).toBeTruthy();

    // Credited what was asked for, not what was charged.
    expect(await balanceOf(customer.id)).toBe(before + 1000);
    const [row] = await sql<{ status: string }>(
      `SELECT "status" FROM "payments" WHERE "id" = $1`,
      [body.paymentId],
    );
    expect(row.status).toBe('completed');
  });

  test('an api key raises the order for the key owner', async ({ request }) => {
    // CombinedAuthGuard accepts x-api-key on this route like any other; the
    // row must land on the key's owner, because that is whose wallet the
    // eventual settlement credits.
    const key = await createKey(request, customer.accessToken, {
      label: 'orders',
    });

    const res = await request.post('/payments/create-order', {
      data: { amount: 1000 },
      headers: { 'x-api-key': key.key },
    });
    expect(res.status(), await res.text()).toBe(201);
    const body = await payload<OrderResponse>(res);

    const [row] = await sql<{ userId: string; status: string }>(
      `SELECT "userId", "status" FROM "payments" WHERE "id" = $1`,
      [body.paymentId],
    );
    expect(row.userId).toBe(customer.id);
    expect(row.status).toBe('created');
  });

  test('there is no idempotency seam: every call mints its own key and its own order — pinned', async ({
    request,
  }) => {
    // The route accepts no client idempotency key: `idempotencyKey` is a
    // server-side randomUUID minted per call (payments.service.ts
    // createOrder) and used as the gateway receipt. So a double-clicked
    // checkout raises TWO gateway orders and TWO rows — pinned as current
    // behaviour, not endorsed. The saving grace, asserted here: an unpaid
    // 'created' row is inert (nothing credits until a signature or webhook
    // names it), every row still carries its own unique key, and neither
    // request is ever answered with the other's order.
    const [a, b] = await Promise.all([
      order(request, customer.accessToken, { amount: 1000 }),
      order(request, customer.accessToken, { amount: 1000 }),
    ]);
    expect(a.status(), await a.text()).toBe(201);
    expect(b.status(), await b.text()).toBe(201);

    const bodyA = await payload<OrderResponse>(a);
    const bodyB = await payload<OrderResponse>(b);
    expect(bodyA.gatewayOrderId).not.toBe(bodyB.gatewayOrderId);
    expect(bodyA.paymentId).not.toBe(bodyB.paymentId);

    const rows = await sql<{
      status: string;
      gatewayOrderId: string;
      idempotencyKey: string;
    }>(
      `SELECT "status", "gatewayOrderId", "idempotencyKey" FROM "payments"
        ORDER BY "createdAt"`,
    );
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r) => r.idempotencyKey)).size).toBe(2);
    expect(new Set(rows.map((r) => r.gatewayOrderId))).toEqual(
      new Set([bodyA.gatewayOrderId, bodyB.gatewayOrderId]),
    );
    for (const row of rows) expect(row.status).toBe('created');
    expect(await balanceOf(customer.id)).toBe(10); // welcome credit only
  });
});
