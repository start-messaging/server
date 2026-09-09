import { test, expect } from '@playwright/test';
import { resetDb, closeDb, sql } from '../helpers/db.js';
import {
  createCustomer,
  onboardCustomer,
  payload,
  Customer,
} from '../helpers/actors.js';
import {
  CHARGED,
  CREDIT,
  balanceOf,
  creditsFor,
  paymentRow,
  postVerify,
  postWebhook,
  seedPayment,
  sign,
  verifyBody,
  webhookEvent,
} from './helpers.js';

/**
 * The Razorpay webhook: `POST /payments/webhook/razorpay`.
 *
 * **The webhook needs no network at all.** It is a plain HMAC over a secret
 * this suite already knows (.env.e2e), so a real signature can be produced
 * here and the whole settlement path — including the money — exercised for
 * real against seeded payment rows.
 *
 * What this file goes after is what happens when the same settlement arrives
 * twice or by both routes at once, and what the API does when the figure the
 * gateway reports is not the figure the order was raised for.
 */

test.describe('payments: the razorpay webhook', () => {
  let customer: Customer;

  test.beforeEach(async ({ request }) => {
    await resetDb();
    customer = await createCustomer(request);
    await onboardCustomer(customer.id);
  });

  test.afterAll(async () => {
    await closeDb();
  });

  test('an unsigned or wrongly signed webhook is acknowledged but not processed', async ({
    request,
  }) => {
    // A non-2xx makes the gateway retry, and a bad signature is not worth
    // retrying — so 2xx with `received: false` is correct, and is not the same
    // thing as "accepted". What must never happen is a 500: this endpoint is
    // public and unauthenticated, and an empty POST once turned
    // Buffer.from(undefined) into one.
    const seeded = await seedPayment({ userId: customer.id });
    const before = await balanceOf(customer.id);
    const captured = webhookEvent('payment.captured', {
      orderId: seeded.orderId,
      paymentId: seeded.paymentId,
      amountPaise: CHARGED * 100,
    });
    const { raw, signature } = sign(captured);

    // A signature computed over a *different* body: the tamper case, where the
    // amount is edited after signing.
    const tampered = sign(
      webhookEvent('payment.captured', {
        orderId: seeded.orderId,
        paymentId: seeded.paymentId,
        amountPaise: 1,
      }),
    );

    const cases: [string | undefined, string][] = [
      [undefined, 'no signature header at all'],
      ['', 'an empty signature'],
      ['zz', 'a signature that is not hex'],
      ['deadbeef', 'a signature of the wrong length'],
      ['f'.repeat(64), 'a well-formed signature with the wrong value'],
      [tampered.signature, 'a signature for a different body'],
    ];

    for (const [candidate, description] of cases) {
      const res = await postWebhook(request, raw, candidate);
      expect(res.status(), `${description} returned ${res.status()}`).toBe(201);
      expect(
        (await payload<{ received: boolean }>(res)).received,
        description,
      ).toBe(false);
    }

    // And the real signature does settle it, so the six refusals above were
    // about the signature and not about something else being wrong.
    const good = await postWebhook(request, raw, signature);
    expect((await payload<{ received: boolean }>(good)).received).toBe(true);
    expect(await balanceOf(customer.id)).toBe(before + CREDIT);
  });

  test('an empty body with no signature does not fall over', async ({
    request,
  }) => {
    const res = await postWebhook(request, '{}');
    expect(res.status(), await res.text()).toBe(201);
    expect((await payload<{ received: boolean }>(res)).received).toBe(false);
  });

  test('a captured amount that is not what the order was raised for credits nothing', async ({
    request,
  }) => {
    // The incident this comparison exists for: the order is raised for the
    // grossed-up ₹1,020, and a gateway reporting the ₹1,000 credit figure
    // means the row and the money have diverged. Settling on the strength of
    // our own record would credit a figure the customer never paid.
    const seeded = await seedPayment({ userId: customer.id });
    const before = await balanceOf(customer.id);

    const { raw, signature } = sign(
      webhookEvent('payment.captured', {
        orderId: seeded.orderId,
        paymentId: seeded.paymentId,
        amountPaise: CREDIT * 100,
      }),
    );
    const res = await postWebhook(request, raw, signature);

    // Acknowledged — there is nothing for the gateway to retry — but pending.
    expect(res.status(), await res.text()).toBe(201);
    expect((await payload<{ received: boolean }>(res)).received).toBe(true);

    const row = await paymentRow(seeded.id);
    expect(row.status, 'a mismatched capture was settled').toBe('created');
    // The early return happens before any save, so not even the gateway's
    // payment id is written.
    expect(row.gatewayPaymentId).toBeNull();
    expect(await creditsFor(seeded.id)).toHaveLength(0);
    expect(await balanceOf(customer.id)).toBe(before);
  });

  test('a single paisa either way is enough to refuse settlement', async ({
    request,
  }) => {
    // The tolerance is 0.009, and paise are the smallest unit the gateway
    // reports, so in practice the figures must match exactly. Under and over
    // are both refused: an overpayment is as much a divergence as a shortfall.
    for (const amountPaise of [CHARGED * 100 - 1, CHARGED * 100 + 1]) {
      const seeded = await seedPayment({ userId: customer.id });
      const before = await balanceOf(customer.id);

      const { raw, signature } = sign(
        webhookEvent('payment.captured', {
          orderId: seeded.orderId,
          paymentId: seeded.paymentId,
          amountPaise,
        }),
      );
      const res = await postWebhook(request, raw, signature);

      expect(res.status(), await res.text()).toBe(201);
      expect(
        (await paymentRow(seeded.id)).status,
        `${amountPaise} paise against an order for ${CHARGED} was settled`,
      ).toBe('created');
      expect(await creditsFor(seeded.id)).toHaveLength(0);
      expect(await balanceOf(customer.id)).toBe(before);
    }
  });

  test('a matching capture credits the top-up and not the charge', async ({
    request,
  }) => {
    const seeded = await seedPayment({ userId: customer.id });
    const before = await balanceOf(customer.id);

    const { raw, signature } = sign(
      webhookEvent('payment.captured', {
        orderId: seeded.orderId,
        paymentId: seeded.paymentId,
        amountPaise: CHARGED * 100,
      }),
    );
    const res = await postWebhook(request, raw, signature);
    expect(res.status(), await res.text()).toBe(201);

    const row = await paymentRow(seeded.id);
    expect(row.status).toBe('completed');
    expect(row.gatewayPaymentId).toBe(seeded.paymentId);

    const credits = await creditsFor(seeded.id);
    expect(credits).toHaveLength(1);
    expect(Number(credits[0].amount)).toBe(CREDIT);
    expect(await balanceOf(customer.id)).toBe(before + CREDIT);
  });

  test('replaying a captured webhook credits the wallet once', async ({
    request,
  }) => {
    // Razorpay retries a webhook it did not get a 2xx for, and delivers
    // duplicates besides. Both deliveries are byte-identical, signature and
    // all, so nothing but the stored status can tell them apart.
    const seeded = await seedPayment({ userId: customer.id });
    const before = await balanceOf(customer.id);
    const { raw, signature } = sign(
      webhookEvent('payment.captured', {
        orderId: seeded.orderId,
        paymentId: seeded.paymentId,
        amountPaise: CHARGED * 100,
      }),
    );

    for (const attempt of [1, 2, 3]) {
      const res = await postWebhook(request, raw, signature);
      expect(res.status(), `delivery ${attempt}`).toBe(201);
      expect((await payload<{ received: boolean }>(res)).received).toBe(true);
    }

    expect(await creditsFor(seeded.id)).toHaveLength(1);
    expect(await balanceOf(customer.id)).toBe(before + CREDIT);
  });

  test('a webhook cannot re-credit a payment the customer already verified', async ({
    request,
  }) => {
    // The two settlement paths race on every real payment: the browser posts
    // the callback while Razorpay posts the webhook. Whichever arrives second
    // must find the row already completed and do nothing.
    const seeded = await seedPayment({ userId: customer.id });
    const before = await balanceOf(customer.id);

    const verified = await postVerify(
      request,
      customer.accessToken,
      verifyBody(seeded),
    );
    expect(verified.status(), await verified.text()).toBe(201);

    const { raw, signature } = sign(
      webhookEvent('payment.captured', {
        orderId: seeded.orderId,
        paymentId: seeded.paymentId,
        amountPaise: CHARGED * 100,
      }),
    );
    const hook = await postWebhook(request, raw, signature);
    expect(hook.status(), await hook.text()).toBe(201);

    expect(await creditsFor(seeded.id)).toHaveLength(1);
    expect(await balanceOf(customer.id)).toBe(before + CREDIT);
  });

  test('a verification cannot re-credit a payment the webhook already settled', async ({
    request,
  }) => {
    const seeded = await seedPayment({ userId: customer.id });
    const before = await balanceOf(customer.id);

    const { raw, signature } = sign(
      webhookEvent('payment.captured', {
        orderId: seeded.orderId,
        paymentId: seeded.paymentId,
        amountPaise: CHARGED * 100,
      }),
    );
    const hook = await postWebhook(request, raw, signature);
    expect(hook.status(), await hook.text()).toBe(201);

    const verified = await postVerify(
      request,
      customer.accessToken,
      verifyBody(seeded),
    );
    expect(verified.status(), await verified.text()).toBe(201);
    expect(await payload(verified)).toEqual({
      status: 'completed',
      message: 'Payment already verified',
    });

    expect(await creditsFor(seeded.id)).toHaveLength(1);
    expect(await balanceOf(customer.id)).toBe(before + CREDIT);
  });

  test('a failed capture marks the payment failed and credits nothing', async ({
    request,
  }) => {
    const seeded = await seedPayment({ userId: customer.id });
    const before = await balanceOf(customer.id);

    const { raw, signature } = sign(
      webhookEvent('payment.failed', {
        orderId: seeded.orderId,
        paymentId: seeded.paymentId,
        amountPaise: CHARGED * 100,
      }),
    );
    const res = await postWebhook(request, raw, signature);
    expect(res.status(), await res.text()).toBe(201);

    const row = await paymentRow(seeded.id);
    expect(row.status).toBe('failed');
    expect(row.gatewayPaymentId).toBe(seeded.paymentId);
    expect(await creditsFor(seeded.id)).toHaveLength(0);
    expect(await balanceOf(customer.id)).toBe(before);
  });

  test('a signed event we do not act on changes nothing', async ({
    request,
  }) => {
    // `payment.authorized` is a real Razorpay event and arrives on every
    // two-step capture. It is valid, it is ours, and it must leave the row
    // exactly where it was.
    const seeded = await seedPayment({ userId: customer.id });
    const before = await balanceOf(customer.id);

    const { raw, signature } = sign(
      webhookEvent('payment.authorized', {
        orderId: seeded.orderId,
        paymentId: seeded.paymentId,
        amountPaise: CHARGED * 100,
      }),
    );
    const res = await postWebhook(request, raw, signature);

    expect(res.status(), await res.text()).toBe(201);
    expect((await payload<{ received: boolean }>(res)).received).toBe(true);

    const row = await paymentRow(seeded.id);
    expect(row.status).toBe('created');
    expect(row.gatewayPaymentId).toBeNull();
    expect(await balanceOf(customer.id)).toBe(before);
  });

  test('a captured event with no payment entity does not fall over', async ({
    request,
  }) => {
    // Signed, so it gets past the HMAC and into the branch that reads
    // `payload.payment.entity` — which is where a missing entity would throw.
    const { raw, signature } = sign({ event: 'payment.captured', payload: {} });
    const res = await postWebhook(request, raw, signature);

    expect(res.status(), await res.text()).toBe(201);
    expect((await payload<{ received: boolean }>(res)).received).toBe(true);
  });

  test('a webhook for an order we never raised is acknowledged and writes nothing', async ({
    request,
  }) => {
    // Also the soft-delete case in the same shape: a payment the application
    // considers gone must not be reachable by a signed webhook either.
    const deleted = await seedPayment({ userId: customer.id, deleted: true });
    const before = await balanceOf(customer.id);

    for (const orderId of ['order_never_existed', deleted.orderId]) {
      const { raw, signature } = sign(
        webhookEvent('payment.captured', {
          orderId,
          paymentId: 'pay_ghost',
          amountPaise: CHARGED * 100,
        }),
      );
      const res = await postWebhook(request, raw, signature);

      expect(res.status(), `order ${orderId}`).toBe(201);
      expect((await payload<{ received: boolean }>(res)).received).toBe(true);
    }

    const [{ count }] = await sql<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM "payments" WHERE "status" = 'completed'`,
    );
    expect(Number(count)).toBe(0);
    expect(await balanceOf(customer.id)).toBe(before);
  });

  test('the webhook settles a payment whose callback was refused', async ({
    request,
  }) => {
    // The recovery path: the customer's browser posted a mangled signature and
    // the verify route refused it, but Razorpay really did capture the money,
    // and the webhook that says so has to settle it. Credited once, for the
    // top-up rather than the charge.
    const seeded = await seedPayment({ userId: customer.id });
    const before = await balanceOf(customer.id);

    const refused = await postVerify(request, customer.accessToken, {
      ...verifyBody(seeded),
      razorpaySignature: 'deadbeef',
    });
    expect(refused.status(), await refused.text()).toBe(400);
    expect((await paymentRow(seeded.id)).status).toBe('created');

    const { raw, signature } = sign(
      webhookEvent('payment.captured', {
        orderId: seeded.orderId,
        paymentId: seeded.paymentId,
        amountPaise: CHARGED * 100,
      }),
    );
    const res = await postWebhook(request, raw, signature);
    expect(res.status(), await res.text()).toBe(201);

    expect((await paymentRow(seeded.id)).status).toBe('completed');
    const credits = await creditsFor(seeded.id);
    expect(credits).toHaveLength(1);
    expect(Number(credits[0].amount)).toBe(CREDIT);
    expect(await balanceOf(customer.id)).toBe(before + CREDIT);
  });
});
