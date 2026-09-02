import { test, expect } from '@playwright/test';
import { resetDb, closeDb, sql } from '../helpers/db.js';
import {
  createAdmin,
  createCustomer,
  createPartner,
  onboardCustomer,
  auth,
  payload,
  Customer,
} from '../helpers/actors.js';
import {
  CHARGED,
  CREDIT,
  balanceOf,
  checkoutSignature,
  complaints,
  creditsFor,
  errorOf,
  paymentRow,
  postVerify,
  seedPayment,
  verifyBody,
} from './helpers.js';

/**
 * Verifying a checkout: `POST /payments/verify`.
 *
 * **Verification needs no network at all.** It is a plain HMAC over a secret
 * this suite already knows (.env.e2e), so a real signature can be produced
 * here and the whole settlement path — including the money — exercised for
 * real against seeded payment rows.
 *
 * payments/convenience-fee.spec.ts owns the fee arithmetic and the reconciliation
 * constraint; this file does not repeat either. What it goes after instead is
 * who may call, and what happens when the same settlement arrives twice or by
 * both routes at once.
 */

test.describe('payments: verifying a checkout', () => {
  let customer: Customer;
  let other: Customer;

  test.beforeEach(async ({ request }) => {
    await resetDb();
    customer = await createCustomer(request);
    await onboardCustomer(customer.id);
    other = await createCustomer(request);
    await onboardCustomer(other.id);
  });

  test.afterAll(async () => {
    await closeDb();
  });

  test('a checkout cannot be verified without a session', async ({
    request,
  }) => {
    const seeded = await seedPayment({ userId: customer.id });

    const anonymous = await request.post('/payments/verify', {
      data: verifyBody(seeded),
    });
    expect(anonymous.status(), await anonymous.text()).toBe(401);
    expect((await errorOf(anonymous)).code).toBe('UNAUTHORIZED');

    const partner = await createPartner(request);
    const asPartner = await postVerify(
      request,
      partner.accessToken,
      verifyBody(seeded),
    );
    expect(asPartner.status(), await asPartner.text()).toBe(401);

    // A perfectly valid signature was presented twice and nothing settled.
    expect((await paymentRow(seeded.id)).status).toBe('created');
    expect(await creditsFor(seeded.id)).toHaveLength(0);
  });

  test('the callback fields are camelCase, and all three are required', async ({
    request,
  }) => {
    const seeded = await seedPayment({ userId: customer.id });
    const signature = checkoutSignature(seeded.orderId, seeded.paymentId);

    // Razorpay Checkout hands the browser snake_case keys. The DTO wants
    // camelCase, so the dashboard has to map them — a body posted straight
    // through is refused, and this is where that shows up.
    const snakeCase = await postVerify(request, customer.accessToken, {
      razorpay_order_id: seeded.orderId,
      razorpay_payment_id: seeded.paymentId,
      razorpay_signature: signature,
    });
    expect(snakeCase.status(), await snakeCase.text()).toBe(400);
    expect((await errorOf(snakeCase)).code).toBe('VALIDATION_ERROR');
    expect(await complaints(snakeCase)).toContain(
      'razorpayOrderId must be a string',
    );

    const cases: [Record<string, unknown>, string][] = [
      [{}, 'an empty body'],
      [
        {
          razorpayOrderId: seeded.orderId,
          razorpayPaymentId: seeded.paymentId,
        },
        'no signature',
      ],
      [{ ...verifyBody(seeded), razorpaySignature: null }, 'a null signature'],
      [
        { ...verifyBody(seeded), razorpayOrderId: [seeded.orderId] },
        'an array where the order id belongs',
      ],
    ];

    for (const [body, description] of cases) {
      const res = await postVerify(request, customer.accessToken, body);
      expect(res.status(), `${description} was accepted`).toBe(400);
      expect((await errorOf(res)).code, description).toBe('VALIDATION_ERROR');
    }

    expect((await paymentRow(seeded.id)).status).toBe('created');
    expect(await creditsFor(seeded.id)).toHaveLength(0);
  });

  test('an empty or coerced order id gets as far as the lookup and no further', async ({
    request,
  }) => {
    // VerifyPaymentDto has @IsString with no @IsNotEmpty, and the pipe coerces
    // implicitly, so `''` and `12345` are both valid strings by the time the
    // service sees them. Neither may resolve to a payment.
    for (const orderId of ['', '   ', 12345, 'order_does_not_exist']) {
      const res = await postVerify(request, customer.accessToken, {
        razorpayOrderId: orderId,
        razorpayPaymentId: 'pay_whatever',
        razorpaySignature: 'deadbeef',
      });
      expect(res.status(), `order id ${JSON.stringify(orderId)}`).toBe(404);
      expect((await errorOf(res)).code).toBe('NOT_FOUND');
    }
  });

  test('an absurdly long order id is a not-found, not a server error', async ({
    request,
  }) => {
    const res = await postVerify(request, customer.accessToken, {
      razorpayOrderId: `order_${'x'.repeat(10_000)}`,
      razorpayPaymentId: `pay_${'y'.repeat(10_000)}`,
      razorpaySignature: 'f'.repeat(10_000),
    });

    expect(res.status(), await res.text()).toBe(404);
  });

  test("a customer cannot verify another customer's payment", async ({
    request,
  }) => {
    const seeded = await seedPayment({ userId: customer.id });
    const beforeVictim = await balanceOf(customer.id);
    const beforeThief = await balanceOf(other.id);

    // A genuinely valid signature — the only thing standing between the thief
    // and the money is the ownership check.
    const res = await postVerify(
      request,
      other.accessToken,
      verifyBody(seeded),
    );

    expect(res.status(), await res.text()).toBe(400);
    const error = await errorOf(res);
    expect(error.message).toBe('Payment does not belong to this user');
    // A 400 with a distinct message, where a 404 would say nothing: an order
    // id that exists answers differently from one that does not, so the pair
    // is an existence oracle. Pinned as it stands; see the file's return note.
    expect(error.code).toBe('INVALID_INPUT');

    expect((await paymentRow(seeded.id)).status).toBe('created');
    expect(await creditsFor(seeded.id)).toHaveLength(0);
    expect(await balanceOf(customer.id)).toBe(beforeVictim);
    expect(await balanceOf(other.id)).toBe(beforeThief);
  });

  test("an admin cannot verify a customer's payment either", async ({
    request,
  }) => {
    // The ownership check is on the user id, with no role escape hatch, so an
    // admin session credits nobody's wallet through this route.
    const admin = await createAdmin(request);
    const seeded = await seedPayment({ userId: customer.id });

    const res = await postVerify(
      request,
      admin.accessToken,
      verifyBody(seeded),
    );

    expect(res.status(), await res.text()).toBe(400);
    expect((await errorOf(res)).message).toBe(
      'Payment does not belong to this user',
    );
    expect(await creditsFor(seeded.id)).toHaveLength(0);
  });

  test('a forged signature credits nothing and leaves the row untouched', async ({
    request,
  }) => {
    const seeded = await seedPayment({ userId: customer.id });
    const before = await balanceOf(customer.id);

    const forgeries = [
      'deadbeef',
      '',
      'zz',
      // Right length, right alphabet, wrong value — this is the case that
      // proves the comparison is a comparison and not a length check.
      'a'.repeat(64),
      checkoutSignature(seeded.orderId, 'pay_a_different_payment'),
    ];

    for (const razorpaySignature of forgeries) {
      const res = await postVerify(request, customer.accessToken, {
        ...verifyBody(seeded),
        razorpaySignature,
      });
      expect(
        res.status(),
        `signature "${razorpaySignature.slice(0, 12)}" was accepted`,
      ).toBe(400);
      expect((await errorOf(res)).message).toBe('Invalid payment signature');
    }

    // The service sets `status = FAILED` and saves it before throwing — but
    // the save and the throw are inside the same SERIALIZABLE transaction, so
    // TypeORM rolls that UPDATE back along with the exception. The row is
    // still `created` and the FAILED branch never reaches the database.
    // Pinned as it stands rather than endorsed: it is what lets a later good
    // callback settle, but it is not what the code reads as if it does.
    expect((await paymentRow(seeded.id)).status).toBe('created');
    expect(await creditsFor(seeded.id)).toHaveLength(0);
    expect(await balanceOf(customer.id)).toBe(before);
  });

  test('a refused callback does not stop the right one from settling', async ({
    request,
  }) => {
    // The customer whose first callback arrived mangled: their money was
    // captured, and the retry with the real signature still credits them.
    // Exactly once. The refused attempt leaves the row exactly as it was —
    // the FAILED write it attempts is rolled back with the exception.
    const seeded = await seedPayment({ userId: customer.id });
    const before = await balanceOf(customer.id);

    const bad = await postVerify(request, customer.accessToken, {
      ...verifyBody(seeded),
      razorpaySignature: 'deadbeef',
    });
    expect(bad.status()).toBe(400);
    expect((await paymentRow(seeded.id)).status).toBe('created');

    const good = await postVerify(
      request,
      customer.accessToken,
      verifyBody(seeded),
    );
    expect(good.status(), await good.text()).toBe(201);

    expect((await paymentRow(seeded.id)).status).toBe('completed');
    expect(await creditsFor(seeded.id)).toHaveLength(1);
    expect(await balanceOf(customer.id)).toBe(before + CREDIT);
  });

  test('a valid signature credits the top-up and not the surcharge', async ({
    request,
  }) => {
    const seeded = await seedPayment({ userId: customer.id });
    const before = await balanceOf(customer.id);

    const res = await postVerify(
      request,
      customer.accessToken,
      verifyBody(seeded),
    );
    expect(res.status(), await res.text()).toBe(201);
    expect(await payload(res)).toEqual({
      status: 'completed',
      message: 'Payment verified and wallet credited',
    });

    const row = await paymentRow(seeded.id);
    expect(row.status).toBe('completed');
    expect(row.gatewayPaymentId).toBe(seeded.paymentId);

    // ₹1,020 left the customer's card; ₹1,000 is what the wallet is worth. The
    // ₹20 went to the gateway and must never appear in the balance.
    const credits = await creditsFor(seeded.id);
    expect(credits).toHaveLength(1);
    expect(Number(credits[0].amount)).toBe(CREDIT);
    expect(Number(credits[0].amount)).not.toBe(CHARGED);
    expect(credits[0].description).toBe('Payment via razorpay');
    expect(Number(credits[0].balanceBefore)).toBe(before);
    expect(Number(credits[0].balanceAfter)).toBe(before + CREDIT);
    expect(await balanceOf(customer.id)).toBe(before + CREDIT);
  });

  test('a top-up in fractions of a rupee is credited to the paisa', async ({
    request,
  }) => {
    // The column is numeric(12,4) and the credit reads it back through
    // Number(), so a top-up that is not a round rupee has to survive the round
    // trip exactly — a truncation here is money quietly kept from a customer.
    const seeded = await seedPayment({
      userId: customer.id,
      amount: 1000.3333,
      convenienceFee: 20.0067,
      chargedAmount: 1020.34,
    });
    const before = await balanceOf(customer.id);

    const res = await postVerify(
      request,
      customer.accessToken,
      verifyBody(seeded),
    );
    expect(res.status(), await res.text()).toBe(201);

    const credits = await creditsFor(seeded.id);
    expect(credits).toHaveLength(1);
    expect(Number(credits[0].amount)).toBe(1000.3333);
    expect(await balanceOf(customer.id)).toBe(before + 1000.3333);
  });

  test('replaying a verification credits the wallet once', async ({
    request,
  }) => {
    // The dashboard retries this call on a flaky network, and a customer who
    // refreshes the success page sends it again by hand.
    const seeded = await seedPayment({ userId: customer.id });
    const before = await balanceOf(customer.id);

    const first = await postVerify(
      request,
      customer.accessToken,
      verifyBody(seeded),
    );
    expect(first.status(), await first.text()).toBe(201);

    const replay = await postVerify(
      request,
      customer.accessToken,
      verifyBody(seeded),
    );
    expect(replay.status(), await replay.text()).toBe(201);
    expect(await payload(replay)).toEqual({
      status: 'completed',
      message: 'Payment already verified',
    });

    expect(await creditsFor(seeded.id)).toHaveLength(1);
    expect(await balanceOf(customer.id)).toBe(before + CREDIT);
  });

  test('two identical verifications sent at once credit the wallet once', async ({
    request,
  }) => {
    // The double-click case. The service runs SERIALIZABLE with the payment
    // row locked, so the loser of the race may come back as a serialization
    // failure rather than a tidy "already verified" — which is why the
    // assertion that matters is on the ledger, not on the status codes.
    const seeded = await seedPayment({ userId: customer.id });
    const before = await balanceOf(customer.id);

    const responses = await Promise.all([
      postVerify(request, customer.accessToken, verifyBody(seeded)),
      postVerify(request, customer.accessToken, verifyBody(seeded)),
    ]);
    const statuses = responses.map((r) => r.status());

    expect(statuses, 'neither concurrent verification succeeded').toContain(
      201,
    );
    expect(await creditsFor(seeded.id)).toHaveLength(1);
    expect(await balanceOf(customer.id)).toBe(before + CREDIT);
    expect((await paymentRow(seeded.id)).status).toBe('completed');
  });

  test('an extra field in the callback cannot change what is credited', async ({
    request,
  }) => {
    // `forbidNonWhitelisted` is off, so unknown properties are stripped rather
    // than refused. Stripped is fine; *read* would not be. The credit comes
    // from the stored row, so an attacker naming their own amount changes
    // nothing.
    const seeded = await seedPayment({ userId: customer.id });
    const before = await balanceOf(customer.id);
    const beforeOther = await balanceOf(other.id);

    const res = await postVerify(
      request,
      customer.accessToken,
      verifyBody(seeded, {
        amount: 999_999,
        chargedAmount: 999_999,
        userId: other.id,
        status: 'refunded',
      }),
    );
    expect(res.status(), await res.text()).toBe(201);

    const credits = await creditsFor(seeded.id);
    expect(credits).toHaveLength(1);
    expect(Number(credits[0].amount)).toBe(CREDIT);
    expect(await balanceOf(customer.id)).toBe(before + CREDIT);
    // And nothing landed in the account named in the extra field.
    expect(await balanceOf(other.id)).toBe(beforeOther);
  });

  test('a payment recorded against an unknown gateway is refused untouched', async ({
    request,
  }) => {
    // `gateway` is a free-text column, so a row written by an integration this
    // build does not have has to be refused rather than verified by Razorpay's
    // secret — and refusing must not burn the row to `failed`.
    const seeded = await seedPayment({
      userId: customer.id,
      gateway: 'stripe',
    });

    const res = await postVerify(
      request,
      customer.accessToken,
      verifyBody(seeded),
    );

    expect(res.status(), await res.text()).toBe(400);
    const error = await errorOf(res);
    expect(error.code).toBe('INVALID_INPUT');
    expect(error.message).toBe('Unknown payment gateway: stripe');

    expect((await paymentRow(seeded.id)).status).toBe('created');
    expect(await creditsFor(seeded.id)).toHaveLength(0);
  });

  test('a soft-deleted payment cannot be verified back into existence', async ({
    request,
  }) => {
    const seeded = await seedPayment({ userId: customer.id, deleted: true });
    const before = await balanceOf(customer.id);

    const res = await postVerify(
      request,
      customer.accessToken,
      verifyBody(seeded),
    );

    expect(res.status(), await res.text()).toBe(404);
    expect((await errorOf(res)).code).toBe('NOT_FOUND');
    expect(await creditsFor(seeded.id)).toHaveLength(0);
    expect(await balanceOf(customer.id)).toBe(before);
  });

  test('a refunded payment is not treated as settled and is credited all over again', async ({
    request,
  }) => {
    // PINNED, NOT ENDORSED. The idempotency check is `status === COMPLETED`
    // only, so a payment that has been refunded — money already returned to
    // the customer — is not treated as settled. Replaying the original
    // checkout callback flips it back to `completed` and credits the wallet
    // for money the business no longer holds. The callback is replayable
    // indefinitely because the signature never expires, so the customer keeps
    // the goods, the refund, and now the balance as well.
    const seeded = await seedPayment({
      userId: customer.id,
      status: 'refunded',
      gatewayPaymentId: 'pay_already_refunded',
    });
    const before = await balanceOf(customer.id);

    const res = await postVerify(
      request,
      customer.accessToken,
      verifyBody(seeded),
    );

    expect(res.status(), await res.text()).toBe(201);
    expect((await paymentRow(seeded.id)).status).toBe('completed');
    expect(await creditsFor(seeded.id)).toHaveLength(1);
    expect(await balanceOf(customer.id)).toBe(before + CREDIT);
  });

  test("a deactivated account's captured payment is still settled", async ({
    request,
  }) => {
    // @SkipOnboarding() steps past OnboardingGuard, and the `isActive` check
    // lives inside that guard — so deactivation does not block this route. It
    // is the defensible outcome (the card was already charged; refusing would
    // strand the money), but it is worth pinning that a suspended account can
    // still move its balance here when every other route is closed to it.
    const seeded = await seedPayment({ userId: customer.id });
    const before = await balanceOf(customer.id);
    await sql(`UPDATE "users" SET "isActive" = false WHERE "id" = $1`, [
      customer.id,
    ]);

    const res = await postVerify(
      request,
      customer.accessToken,
      verifyBody(seeded),
    );
    expect(res.status(), await res.text()).toBe(201);
    expect(await balanceOf(customer.id)).toBe(before + CREDIT);

    // Contrast: a route that keeps the guard refuses the same session.
    const guarded = await request.get('/payments/fee-quote?amount=1000', {
      headers: auth(customer.accessToken),
    });
    expect(guarded.status(), await guarded.text()).toBe(403);
    expect((await errorOf(guarded)).message).toBe(
      'This account has been deactivated.',
    );
  });
});
