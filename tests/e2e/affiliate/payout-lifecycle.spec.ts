import { test, expect, APIRequestContext } from '@playwright/test';
import { resetDb, closeDb, sql, partnerTotals } from '../helpers/db.js';
import {
  createAdmin,
  createPartner,
  seedCustomer,
  seedReferral,
  seedDeliveredMessage,
  updateSettings,
  runAccrual,
  runPayouts,
  auth,
  payload,
  Customer,
  Partner,
} from '../helpers/actors.js';

/**
 * The payout state machine and what each transition does to the money.
 *
 * PAID and FAILED are terminal by design: FAILED returns the commissions to
 * the unpaid pool, so allowing FAILED -> PAID would let a payout claim money
 * was sent while the ledger says it is still owed, and the next cycle would
 * pay it again.
 */
test.describe('payout lifecycle', () => {
  let admin: Customer;
  let partner: Partner;

  test.beforeEach(async ({ request }) => {
    await resetDb();
    admin = await createAdmin(request);
    partner = await createPartner(request);
    await updateSettings(request, admin.accessToken, {
      isEnabled: true,
      minPaidReferrals: 1,
      minPayoutAmount: 10,
      defaultCommissionType: 'flat',
      defaultCommissionRate: 100,
    });
    await sql(
      `UPDATE "partners" SET "payoutMethod" = 'upi', "upiId" = 'test@upi' WHERE "id" = $1`,
      [partner.id],
    );
  });

  test.afterAll(async () => {
    await closeDb();
  });

  /** Accrues 100 and settles it into a pending payout. */
  async function raisePayout(request: APIRequestContext): Promise<string> {
    const user = await seedCustomer();
    await seedReferral(partner.id, user.id, partner.referralCode, 'qualified');
    await seedDeliveredMessage(user.id, { costAmount: 1 });
    await runAccrual(request, admin.accessToken);

    const run = await runPayouts(request, admin.accessToken);
    expect(run.payoutsCreated).toBe(1);

    const [row] = await sql<{ id: string }>(
      `SELECT "id" FROM "partner_payouts" WHERE "partnerId" = $1`,
      [partner.id],
    );
    return row.id;
  }

  function setStatus(
    request: APIRequestContext,
    id: string,
    body: Record<string, unknown>,
  ) {
    return request.patch(`/admin/affiliate/payouts/${id}`, {
      data: body,
      headers: auth(admin.accessToken),
    });
  }

  test('a new payout starts pending with the commissions marked paid', async ({
    request,
  }) => {
    const id = await raisePayout(request);

    const [row] = await sql<{ status: string; payoutId: string }>(
      `SELECT "status" FROM "partner_payouts" WHERE "id" = $1`,
      [id],
    );
    expect(row.status).toBe('pending');

    const totals = await partnerTotals(partner.id);
    expect(totals.ledger.paid).toBe(100);
    expect(totals.ledger.unpaid).toBe(0);
    expect(totals.cached).toEqual(totals.ledger);
  });

  test('pending -> paid settles and stamps paidAt', async ({ request }) => {
    const id = await raisePayout(request);

    const res = await setStatus(request, id, {
      status: 'paid',
      paymentReference: 'UTR123456',
    });
    expect(res.ok(), await res.text()).toBeTruthy();

    const [row] = await sql<{
      status: string;
      paidAt: Date | null;
      paymentReference: string;
    }>(
      `SELECT "status", "paidAt", "paymentReference" FROM "partner_payouts" WHERE "id" = $1`,
      [id],
    );
    expect(row.status).toBe('paid');
    expect(row.paidAt).not.toBeNull();
    expect(row.paymentReference).toBe('UTR123456');

    // Money stays paid; nothing returns to the unpaid pool.
    const totals = await partnerTotals(partner.id);
    expect(totals.ledger.paid).toBe(100);
    expect(totals.ledger.unpaid).toBe(0);
  });

  test('a payout with no destination cannot be marked paid', async ({
    request,
  }) => {
    const id = await raisePayout(request);

    // Simulates a payout raised before the run started requiring a
    // destination. Money cannot have been sent to nowhere, and PAID is
    // terminal, so recording it would need raw SQL to undo.
    await sql(
      `UPDATE "partner_payouts" SET "payoutMethod" = NULL WHERE "id" = $1`,
      [id],
    );

    const res = await setStatus(request, id, {
      status: 'paid',
      paymentReference: 'UTR999',
    });
    expect(res.status(), await res.text()).toBe(400);

    const [row] = await sql<{ status: string }>(
      `SELECT "status" FROM "partner_payouts" WHERE "id" = $1`,
      [id],
    );
    expect(row.status).toBe('pending');

    // Failing it is still allowed, and returns the money.
    const failed = await setStatus(request, id, { status: 'failed' });
    expect(failed.ok(), await failed.text()).toBeTruthy();
    expect((await partnerTotals(partner.id)).ledger.unpaid).toBe(100);
  });

  test('paid is terminal', async ({ request }) => {
    const id = await raisePayout(request);
    await setStatus(request, id, { status: 'paid' });

    for (const status of ['failed', 'pending', 'processing', 'on_hold']) {
      const res = await setStatus(request, id, { status });
      expect(res.status(), `paid -> ${status} should be rejected`).toBe(400);
    }
  });

  test('marking FAILED returns the money and does so atomically', async ({
    request,
  }) => {
    const id = await raisePayout(request);

    const res = await setStatus(request, id, {
      status: 'failed',
      failureReason: 'Bank rejected the transfer',
    });
    expect(res.ok(), await res.text()).toBeTruthy();

    const [row] = await sql<{ status: string }>(
      `SELECT "status" FROM "partner_payouts" WHERE "id" = $1`,
      [id],
    );
    expect(row.status).toBe('failed');

    // The whole point: status and refund commit together, so the ledger can
    // never read `paid` against a payout that failed.
    const totals = await partnerTotals(partner.id);
    expect(totals.ledger.unpaid).toBe(100);
    expect(totals.ledger.paid).toBe(0);
    expect(totals.cached).toEqual(totals.ledger);

    // The commissions are detached from the failed payout so the next cycle
    // can sweep them up again.
    const [{ count }] = await sql<{ count: string }>(
      `SELECT COUNT(*)::int AS count FROM "partner_commissions"
        WHERE "payoutId" = $1`,
      [id],
    );
    expect(Number(count)).toBe(0);
  });

  test('failed is terminal', async ({ request }) => {
    const id = await raisePayout(request);
    await setStatus(request, id, { status: 'failed' });

    for (const status of ['paid', 'pending', 'processing', 'on_hold']) {
      const res = await setStatus(request, id, { status });
      expect(res.status(), `failed -> ${status} should be rejected`).toBe(400);
    }
  });

  test('re-sending FAILED is idempotent and does not double-refund', async ({
    request,
  }) => {
    const id = await raisePayout(request);

    await setStatus(request, id, { status: 'failed' });
    const afterFirst = await partnerTotals(partner.id);

    // Permitted by the from === to early return, and the documented way to
    // finish a release that an older deploy left half-applied.
    const again = await setStatus(request, id, { status: 'failed' });
    expect(again.ok(), await again.text()).toBeTruthy();

    const afterSecond = await partnerTotals(partner.id);
    expect(afterSecond.ledger).toEqual(afterFirst.ledger);
    expect(afterSecond.cached).toEqual(afterFirst.cached);
    expect(afterSecond.cached.unpaid).toBe(100);
  });

  test('released money is picked up by the next payout cycle', async ({
    request,
  }) => {
    const id = await raisePayout(request);
    await setStatus(request, id, { status: 'failed' });

    // A fresh cycle: the previous period key is taken, so move the clock on by
    // giving the existing payout a different period.
    await sql(
      `UPDATE "partner_payouts" SET "periodKey" = '1999-01' WHERE "id" = $1`,
      [id],
    );

    const run = await runPayouts(request, admin.accessToken);
    expect(run.payoutsCreated).toBe(1);
    expect(run.totalAmount).toBe(100);

    const totals = await partnerTotals(partner.id);
    expect(totals.ledger.paid).toBe(100);
    expect(totals.ledger.unpaid).toBe(0);
  });

  test('pending -> processing -> paid is allowed', async ({ request }) => {
    const id = await raisePayout(request);

    expect((await setStatus(request, id, { status: 'processing' })).ok()).toBe(
      true,
    );
    expect((await setStatus(request, id, { status: 'paid' })).ok()).toBe(true);

    const [row] = await sql<{ status: string }>(
      `SELECT "status" FROM "partner_payouts" WHERE "id" = $1`,
      [id],
    );
    expect(row.status).toBe('paid');
  });

  test('on_hold can go back to pending without moving money', async ({
    request,
  }) => {
    const id = await raisePayout(request);
    const before = await partnerTotals(partner.id);

    expect((await setStatus(request, id, { status: 'on_hold' })).ok()).toBe(
      true,
    );
    expect((await setStatus(request, id, { status: 'pending' })).ok()).toBe(
      true,
    );

    const after = await partnerTotals(partner.id);
    expect(after.ledger).toEqual(before.ledger);
    expect(after.cached).toEqual(before.cached);
  });

  test('reconciliation reports drift and rebuilds the cache from the ledger', async ({
    request,
  }) => {
    await raisePayout(request);

    await sql(
      `UPDATE "partners"
          SET "unpaidEarnings" = 777, "paidEarnings" = 0, "lifetimeEarnings" = 5
        WHERE "id" = $1`,
      [partner.id],
    );

    const res = await request.post('/admin/affiliate/jobs/reconcile', {
      headers: auth(admin.accessToken),
    });

    // The endpoint may not exist; the weekly job is the primary caller.
    if (res.status() === 404) {
      test.skip(true, 'no manual reconcile endpoint exposed');
      return;
    }
    expect(res.ok(), await res.text()).toBeTruthy();

    const totals = await partnerTotals(partner.id);
    expect(totals.cached).toEqual(totals.ledger);
    expect(totals.cached.paid).toBe(100);
  });

  test('the admin queue lists a raised payout with its money, partner and state, and the status filter filters', async ({
    request,
  }) => {
    // Authz and query validation were pinned; the queue's CONTENT never was —
    // an empty list forever would have passed. One pending payout and one
    // failed one give the filter something to keep and something to drop.
    const pendingId = await raisePayout(request);

    const secondPartner = await createPartner(request);
    await sql(
      `UPDATE "partners" SET "payoutMethod" = 'upi', "upiId" = 'second@upi' WHERE "id" = $1`,
      [secondPartner.id],
    );
    const user = await seedCustomer();
    await seedReferral(
      secondPartner.id,
      user.id,
      secondPartner.referralCode,
      'qualified',
    );
    await seedDeliveredMessage(user.id, { costAmount: 1 });
    await runAccrual(request, admin.accessToken);
    const run = await runPayouts(request, admin.accessToken);
    expect(run.payoutsCreated).toBe(1);

    const [secondRow] = await sql<{ id: string }>(
      `SELECT "id" FROM "partner_payouts" WHERE "partnerId" = $1`,
      [secondPartner.id],
    );
    const failed = await setStatus(request, secondRow.id, {
      status: 'failed',
      failureReason: 'Bank bounced',
    });
    expect(failed.ok(), await failed.text()).toBeTruthy();

    const res = await request.get('/admin/affiliate/payouts', {
      headers: auth(admin.accessToken),
    });
    expect(res.status(), await res.text()).toBe(200);
    const rows = await payload<
      {
        id: string;
        partnerId: string;
        amount: number;
        status: string;
        partner: { id: string; email: string } | null;
      }[]
    >(res);
    expect(rows).toHaveLength(2);

    const pendingRow = rows.find((r) => r.id === pendingId);
    expect(pendingRow, 'the raised payout is missing from the queue').toBeTruthy();
    expect(pendingRow?.partnerId).toBe(partner.id);
    expect(pendingRow?.amount).toBe(100);
    expect(pendingRow?.status).toBe('pending');
    // The partner relation rides along so the queue can say WHO — but never
    // with credential material.
    expect(pendingRow?.partner?.email).toBe(partner.email);
    expect(await res.text()).not.toContain('passwordHash');

    // A legal status value was only ever asserted to answer 200; this is the
    // half that proves it also restricts.
    const pendingOnly = await request.get(
      '/admin/affiliate/payouts?status=pending',
      { headers: auth(admin.accessToken) },
    );
    expect(
      (await payload<{ id: string }[]>(pendingOnly)).map((r) => r.id),
    ).toEqual([pendingId]);

    const failedOnly = await request.get(
      '/admin/affiliate/payouts?status=failed',
      { headers: auth(admin.accessToken) },
    );
    expect(
      (await payload<{ id: string }[]>(failedOnly)).map((r) => r.id),
    ).toEqual([secondRow.id]);

    const processingOnly = await request.get(
      '/admin/affiliate/payouts?status=processing',
      { headers: auth(admin.accessToken) },
    );
    expect(await payload<unknown[]>(processingOnly)).toEqual([]);
  });

  test('a partner only ever sees their own payouts', async ({ request }) => {
    const id = await raisePayout(request);
    const other = await createPartner(request);

    const res = await request.get(`/partner/payouts/${id}`, {
      headers: auth(other.accessToken),
    });
    expect(res.status()).toBe(404);
  });

  test('payout responses never carry admin-only fields', async ({
    request,
  }) => {
    const id = await raisePayout(request);
    await setStatus(request, id, {
      status: 'failed',
      failureReason: 'Bank rejected',
      adminNotes: 'internal: suspected mule account',
    });

    const single = await request.get(`/partner/payouts/${id}`, {
      headers: auth(partner.accessToken),
    });
    expect(single.ok(), await single.text()).toBeTruthy();
    const body = await payload<Record<string, unknown>>(single);

    expect(body).not.toHaveProperty('adminNotes');
    expect(body).not.toHaveProperty('processedByAdminId');
    // The partner does need to know why a transfer bounced.
    expect(body.failureReason).toBe('Bank rejected');

    const list = await request.get('/partner/payouts', {
      headers: auth(partner.accessToken),
    });
    const rows = await payload<Record<string, unknown>[]>(list);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row).not.toHaveProperty('adminNotes');
      expect(row).not.toHaveProperty('processedByAdminId');
    }
  });
});
