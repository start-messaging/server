import { test, expect } from '@playwright/test';
import { resetDb, closeDb, sql } from '../helpers/db.js';
import {
  createAdmin,
  createCustomer,
  onboardCustomer,
  payload,
  auth,
  Customer,
} from '../helpers/actors.js';
import {
  CHARGED,
  CREDIT,
  ReconcileReportBody,
  balanceOf,
  creditsFor,
  paymentRow,
  postVerify,
  postWebhook,
  reconcile,
  seedPayment,
  sign,
  verifyBody,
  webhookEvent,
} from './helpers.js';

/**
 * The reconciliation sweep: `POST /admin/payments/reconcile`, the same sweep
 * the scheduler runs every five minutes in production.
 *
 * It exists for the payment nobody told us about: the customer paid, then the
 * browser callback never arrived (closed tab, dropped connection) and the
 * webhook never arrived (never configured, wrong secret). The order sits at
 * `created`, the customer has paid, and nothing anywhere notices.
 *
 * The gateway is the fake one (PAYMENTS_FAKE_GATEWAY), which answers "what
 * happened to this order?" from `metadata.fakeGatewayPayments` on the row — so
 * the whole path, including the money, runs for real without touching Razorpay.
 */

const CAPTURED = (id: string, amount = CHARGED) => ({
  id,
  status: 'captured',
  amount,
});

test.describe('payments: reconciliation sweep', () => {
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

  test('a payment the gateway captured but nobody reported is credited, once', async ({
    request,
  }) => {
    const seeded = await seedPayment({
      userId: customer.id,
      gatewayPayments: [CAPTURED('pay_captured_1')],
    });
    const before = await balanceOf(customer.id);

    const res = await reconcile(request, admin.accessToken);
    expect(res.status(), await res.text()).toBe(201);
    const report = await payload<ReconcileReportBody>(res);
    expect(report.entries).toEqual([
      expect.objectContaining({
        gatewayOrderId: seeded.orderId,
        outcome: 'settled',
        gatewayPaymentId: 'pay_captured_1',
        // The wallet gets the top-up, not the ₹1,020 the card was charged.
        amount: CREDIT,
      }),
    ]);

    const row = await paymentRow(seeded.id);
    expect(row.status).toBe('completed');
    expect(row.gatewayPaymentId).toBe('pay_captured_1');
    const credits = await creditsFor(seeded.id);
    expect(credits).toHaveLength(1);
    expect(Number(credits[0].amount)).toBe(CREDIT);
    expect(await balanceOf(customer.id)).toBe(before + CREDIT);

    // Sweeping again finds nothing to do and credits nothing more.
    const again = await payload<ReconcileReportBody>(
      await reconcile(request, admin.accessToken),
    );
    expect(again.entries).toEqual([]);
    expect(await creditsFor(seeded.id)).toHaveLength(1);
    expect(await balanceOf(customer.id)).toBe(before + CREDIT);
  });

  test('a dry run reports what it would credit and writes nothing', async ({
    request,
  }) => {
    const seeded = await seedPayment({
      userId: customer.id,
      gatewayPayments: [CAPTURED('pay_dry')],
    });
    const before = await balanceOf(customer.id);

    const report = await payload<ReconcileReportBody>(
      await reconcile(request, admin.accessToken, { dryRun: true }),
    );
    expect(report.dryRun).toBe(true);
    expect(report.entries).toEqual([
      expect.objectContaining({
        gatewayOrderId: seeded.orderId,
        outcome: 'would_settle',
      }),
    ]);

    expect((await paymentRow(seeded.id)).status).toBe('created');
    expect(await creditsFor(seeded.id)).toHaveLength(0);
    expect(await balanceOf(customer.id)).toBe(before);
  });

  test('an abandoned checkout is left alone and is not reported', async ({
    request,
  }) => {
    const seeded = await seedPayment({ userId: customer.id });
    const before = await balanceOf(customer.id);

    const report = await payload<ReconcileReportBody>(
      await reconcile(request, admin.accessToken),
    );
    expect(report.checked).toBe(1);
    expect(report.entries).toEqual([]);
    expect((await paymentRow(seeded.id)).status).toBe('created');
    expect(await balanceOf(customer.id)).toBe(before);
  });

  test('an attempt that failed at the gateway is not money and credits nothing', async ({
    request,
  }) => {
    const seeded = await seedPayment({
      userId: customer.id,
      gatewayPayments: [{ id: 'pay_bad', status: 'failed', amount: CHARGED }],
    });
    const report = await payload<ReconcileReportBody>(
      await reconcile(request, admin.accessToken),
    );
    expect(report.entries).toEqual([]);
    expect(await creditsFor(seeded.id)).toHaveLength(0);
  });

  test('an authorised-but-uncaptured payment is surfaced, not credited', async ({
    request,
  }) => {
    // Held, not taken: the gateway refunds it to the customer after a few
    // days. It is the one case the sweep cannot fix, so it must be visible.
    const held = [{ id: 'pay_held', status: 'authorized', amount: CHARGED }];
    // Fresh: automatic capture can legitimately take up to twelve minutes, so
    // an authorisation this young is normal and must not raise an alarm.
    await seedPayment({ userId: customer.id, gatewayPayments: held });
    const fresh = await payload<ReconcileReportBody>(
      await reconcile(request, admin.accessToken),
    );
    expect(fresh.entries).toEqual([]);

    // Old enough that capture should have happened by now.
    const seeded = await seedPayment({
      userId: customer.id,
      ageMinutes: 45,
      gatewayPayments: held,
    });
    const before = await balanceOf(customer.id);

    const report = await payload<ReconcileReportBody>(
      await reconcile(request, admin.accessToken),
    );
    expect(report.entries).toEqual([
      expect.objectContaining({
        gatewayOrderId: seeded.orderId,
        outcome: 'authorized_not_captured',
      }),
    ]);
    expect(await creditsFor(seeded.id)).toHaveLength(0);
    expect(await balanceOf(customer.id)).toBe(before);
  });

  test('a capture for a different amount than the order is reported and credits nothing', async ({
    request,
  }) => {
    const seeded = await seedPayment({
      userId: customer.id,
      gatewayPayments: [CAPTURED('pay_wrong_amount', CREDIT)],
    });
    const before = await balanceOf(customer.id);

    const report = await payload<ReconcileReportBody>(
      await reconcile(request, admin.accessToken),
    );
    expect(report.entries).toEqual([
      expect.objectContaining({
        gatewayOrderId: seeded.orderId,
        outcome: 'amount_mismatch',
      }),
    ]);
    expect((await paymentRow(seeded.id)).status).toBe('created');
    expect(await creditsFor(seeded.id)).toHaveLength(0);
    expect(await balanceOf(customer.id)).toBe(before);
  });

  test('an order an admin already credited by hand is flagged, never paid twice', async ({
    request,
  }) => {
    // Before this sweep existed, a missed payment was fixed by crediting the
    // wallet manually, which left the order at `created`. Sweeping it would
    // pay the customer a second time.
    const seeded = await seedPayment({
      userId: customer.id,
      ageMinutes: 30,
      gatewayPayments: [CAPTURED('pay_manual')],
    });
    const manual = await request.post('/admin/wallet/topup', {
      data: {
        email: customer.email,
        amount: CREDIT,
        description: 'Payment received — credited to your wallet',
      },
      headers: auth(admin.accessToken),
    });
    expect(manual.status(), await manual.text()).toBe(201);
    const before = await balanceOf(customer.id);

    const report = await payload<ReconcileReportBody>(
      await reconcile(request, admin.accessToken),
    );
    expect(report.entries).toEqual([
      expect.objectContaining({
        gatewayOrderId: seeded.orderId,
        outcome: 'manual_review',
      }),
    ]);
    expect((await paymentRow(seeded.id)).status).toBe('created');
    expect(await creditsFor(seeded.id)).toHaveLength(0);
    expect(await balanceOf(customer.id)).toBe(before);
  });

  test('an order whose attempt failed and was then paid is settled', async ({
    request,
  }) => {
    // A `payment.failed` event marks the order FAILED, and the customer can
    // retry inside the same order and succeed. Skipping FAILED rows would
    // leave exactly those customers uncredited.
    const seeded = await seedPayment({
      userId: customer.id,
      status: 'failed',
      gatewayPayments: [
        { id: 'pay_first_try', status: 'failed', amount: CHARGED },
        CAPTURED('pay_second_try'),
      ],
    });
    const before = await balanceOf(customer.id);

    await reconcile(request, admin.accessToken);
    expect((await paymentRow(seeded.id)).status).toBe('completed');
    expect(await creditsFor(seeded.id)).toHaveLength(1);
    expect(await balanceOf(customer.id)).toBe(before + CREDIT);
  });

  test('the window: too old, too young, and already settled orders are not asked about', async ({
    request,
  }) => {
    const tooOld = await seedPayment({
      userId: customer.id,
      ageMinutes: 80 * 60,
      gatewayPayments: [CAPTURED('pay_old')],
    });
    const tooYoung = await seedPayment({
      userId: customer.id,
      gatewayPayments: [CAPTURED('pay_young')],
    });
    const done = await seedPayment({
      userId: customer.id,
      status: 'completed',
      gatewayPaymentId: 'pay_done',
      gatewayPayments: [CAPTURED('pay_done')],
    });
    const before = await balanceOf(customer.id);

    // Default 72h lookback, and a real three-minute floor.
    const res = await request.post('/admin/payments/reconcile', {
      data: {},
      headers: auth(admin.accessToken),
    });
    const report = await payload<ReconcileReportBody>(res);
    expect(report.checked).toBe(0);
    expect(report.entries).toEqual([]);

    for (const p of [tooOld, tooYoung]) {
      expect((await paymentRow(p.id)).status).toBe('created');
      expect(await creditsFor(p.id)).toHaveLength(0);
    }
    expect(await creditsFor(done.id)).toHaveLength(0);
    expect(await balanceOf(customer.id)).toBe(before);

    // A wider window reaches the old one — an admin recovering history.
    const wide = await payload<ReconcileReportBody>(
      await reconcile(request, admin.accessToken, { lookbackHours: 200, minAgeMinutes: 3 }),
    );
    expect(wide.entries.map((e) => e.gatewayOrderId)).toEqual([tooOld.orderId]);
  });

  test('a refunded payment is never swept back into a credit', async ({
    request,
  }) => {
    const seeded = await seedPayment({
      userId: customer.id,
      status: 'refunded',
      gatewayPaymentId: 'pay_refunded',
      gatewayPayments: [CAPTURED('pay_refunded')],
    });
    const before = await balanceOf(customer.id);
    await reconcile(request, admin.accessToken);
    expect((await paymentRow(seeded.id)).status).toBe('refunded');
    expect(await creditsFor(seeded.id)).toHaveLength(0);
    expect(await balanceOf(customer.id)).toBe(before);
  });

  test('the sweep racing the browser callback and the webhook credits once', async ({
    request,
  }) => {
    const seeded = await seedPayment({
      userId: customer.id,
      gatewayPayments: [CAPTURED(`pay_${'race'}`)],
    });
    const before = await balanceOf(customer.id);
    const { raw, signature } = sign(
      webhookEvent('payment.captured', {
        orderId: seeded.orderId,
        paymentId: seeded.paymentId,
        amountPaise: CHARGED * 100,
      }),
    );

    const responses = await Promise.all([
      postVerify(request, customer.accessToken, verifyBody(seeded)),
      postWebhook(request, raw, signature),
      reconcile(request, admin.accessToken),
      reconcile(request, admin.accessToken),
    ]);
    for (const r of responses) {
      expect(r.status(), await r.text()).toBe(201);
    }

    expect(await creditsFor(seeded.id)).toHaveLength(1);
    expect(await balanceOf(customer.id)).toBe(before + CREDIT);
    expect((await paymentRow(seeded.id)).status).toBe('completed');
  });

  test('only an admin can run it, and its bounds are enforced', async ({
    request,
  }) => {
    const anon = await request.post('/admin/payments/reconcile', { data: {} });
    expect(anon.status()).toBe(401);

    const asCustomer = await reconcile(request, customer.accessToken);
    expect(asCustomer.status(), await asCustomer.text()).toBe(403);

    for (const bad of [
      { lookbackHours: 0 },
      { lookbackHours: 99999 },
      { limit: 0 },
      { limit: 100000 },
      { minAgeMinutes: -1 },
      { lookbackHours: 1.5 },
    ]) {
      const res = await reconcile(request, admin.accessToken, bad);
      expect(res.status(), JSON.stringify(bad)).toBe(400);
    }
  });

  test('the ledger itself refuses a second credit for the same payment', async () => {
    // The backstop under every code path: even a path that forgot the lock and
    // the status check cannot write a second credit for one payment.
    const seeded = await seedPayment({ userId: customer.id });
    const [{ id: walletId }] = await sql<{ id: string }>(
      `SELECT "id" FROM "wallets" WHERE "userId" = $1`,
      [customer.id],
    );
    const insert = (type: string, referenceType: string) =>
      sql(
        `INSERT INTO "wallet_transactions"
           ("walletId","type","amount","balanceBefore","balanceAfter",
            "referenceType","referenceId","description")
         VALUES ($1, $2::"wallet_transactions_type_enum", 1, 0, 1, $3, $4, 'x')`,
        [walletId, type, referenceType, seeded.id],
      );

    await insert('credit', 'payment');
    await expect(insert('credit', 'payment')).rejects.toThrow(
      /UQ_wallet_tx_payment_credit|duplicate key/,
    );
    // A debit or refund against the same reference is legitimate, and so is a
    // manual credit — the index is about payment credits only.
    await insert('debit', 'payment');
    await insert('credit', 'admin_topup');
    await insert('refund', 'payment');
  });
});
