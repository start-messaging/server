import { test, expect } from '@playwright/test';
import { resetDb, closeDb, sql, readSettings, partnerTotals } from './helpers/db.js';
import {
  createAdmin,
  createPartner,
  seedCustomer,
  seedReferral,
  seedDeliveredMessage,
  seedCompletedPayment,
  updateSettings,
  runAccrual,
  auth,
  Customer,
  Partner,
} from './helpers/actors.js';

const HOUR = 60 * 60 * 1000;

/**
 * Commission accrual: how partners actually earn.
 *
 * Every assertion here is against the ledger rather than the run summary,
 * because the failure mode that matters is a run that reports success while
 * writing the wrong money.
 */
test.describe('commission accrual', () => {
  let admin: Customer;
  let partner: Partner;

  test.beforeEach(async ({ request }) => {
    await resetDb();
    admin = await createAdmin(request);
    partner = await createPartner(request);
    // The programme ships disabled; every test here needs it on.
    const res = await updateSettings(request, admin.accessToken, {
      isEnabled: true,
    });
    expect(res.ok(), await res.text()).toBeTruthy();
  });

  test.afterAll(async () => {
    await closeDb();
  });

  /** A referred user with one delivered OTP inside the window. */
  async function referredUserWithOtp(
    opts: { cost?: number; updatedAt?: Date; status?: string } = {},
  ) {
    const user = await seedCustomer();
    await seedReferral(partner.id, user.id, partner.referralCode);
    const messageId = await seedDeliveredMessage(user.id, {
      costAmount: opts.cost ?? 0.25,
      updatedAt: opts.updatedAt,
      status: opts.status,
    });
    return { user, messageId };
  }

  test('accrues percent commission and credits the cached totals', async ({
    request,
  }) => {
    await referredUserWithOtp({ cost: 10 });

    const run = await runAccrual(request, admin.accessToken);
    expect(run.skipped).toBe(false);
    expect(run.commissionsCreated).toBe(1);

    // Default rate is 10 percent of the message cost.
    const [commission] = await sql<{ amount: string; rateType: string; baseAmount: string }>(
      `SELECT "amount", "rateType", "baseAmount" FROM "partner_commissions"`,
    );
    expect(commission.rateType).toBe('percent');
    expect(Number(commission.baseAmount)).toBe(10);
    expect(Number(commission.amount)).toBe(1);

    const totals = await partnerTotals(partner.id);
    expect(totals.ledger.unpaid).toBe(1);
    expect(totals.cached).toEqual(totals.ledger);
  });

  test('is idempotent: re-running never pays twice for one message', async ({
    request,
  }) => {
    await referredUserWithOtp({ cost: 10 });

    const first = await runAccrual(request, admin.accessToken);
    const second = await runAccrual(request, admin.accessToken);
    const third = await runAccrual(request, admin.accessToken);

    expect(first.commissionsCreated).toBe(1);
    expect(second.commissionsCreated).toBe(0);
    expect(third.commissionsCreated).toBe(0);

    const totals = await partnerTotals(partner.id);
    expect(totals.ledger.unpaid).toBe(1);
    expect(totals.cached.unpaid).toBe(1);
  });

  test('does nothing while the programme is disabled', async ({ request }) => {
    await updateSettings(request, admin.accessToken, { isEnabled: false });
    await referredUserWithOtp({ cost: 10 });

    const run = await runAccrual(request, admin.accessToken);
    expect(run.skipped).toBe(true);

    const [{ count }] = await sql<{ count: string }>(
      `SELECT COUNT(*)::int AS count FROM "partner_commissions"`,
    );
    expect(Number(count)).toBe(0);
  });

  test('only delivered, positive-cost messages earn', async ({ request }) => {
    const user = await seedCustomer();
    await seedReferral(partner.id, user.id, partner.referralCode);

    await seedDeliveredMessage(user.id, { costAmount: 10, status: 'failed' });
    await seedDeliveredMessage(user.id, { costAmount: 10, status: 'queued' });
    await seedDeliveredMessage(user.id, { costAmount: 0, status: 'delivered' });
    await seedDeliveredMessage(user.id, { costAmount: 10, status: 'delivered' });

    const run = await runAccrual(request, admin.accessToken);
    expect(run.commissionsCreated).toBe(1);
    expect(Number((await partnerTotals(partner.id)).ledger.unpaid)).toBe(1);
  });

  test('a blocked referral earns nothing', async ({ request }) => {
    const user = await seedCustomer();
    await seedReferral(partner.id, user.id, partner.referralCode, 'blocked');
    await seedDeliveredMessage(user.id, { costAmount: 10 });

    const run = await runAccrual(request, admin.accessToken);
    expect(run.commissionsCreated).toBe(0);
  });

  test('a suspended partner earns nothing', async ({ request }) => {
    const user = await seedCustomer();
    await seedReferral(partner.id, user.id, partner.referralCode);
    await seedDeliveredMessage(user.id, { costAmount: 10 });
    await sql(`UPDATE "partners" SET "status" = 'suspended' WHERE "id" = $1`, [
      partner.id,
    ]);

    const run = await runAccrual(request, admin.accessToken);
    expect(run.commissionsCreated).toBe(0);
  });

  test('messages outside the lookback window do not accrue', async ({
    request,
  }) => {
    // Default lookback is 168h. Something updated 200h ago is outside it.
    await referredUserWithOtp({
      cost: 10,
      updatedAt: new Date(Date.now() - 200 * HOUR),
    });

    const run = await runAccrual(request, admin.accessToken);
    expect(run.commissionsCreated).toBe(0);
  });

  test('a flat rate pays per delivered OTP regardless of cost', async ({
    request,
  }) => {
    await updateSettings(request, admin.accessToken, {
      defaultCommissionType: 'flat',
      defaultCommissionRate: 2,
    });
    await referredUserWithOtp({ cost: 10 });

    await runAccrual(request, admin.accessToken);

    const [commission] = await sql<{ amount: string; rateType: string }>(
      `SELECT "amount", "rateType" FROM "partner_commissions"`,
    );
    expect(commission.rateType).toBe('flat');
    expect(Number(commission.amount)).toBe(2);
  });

  test('a per-partner override beats the global default', async ({
    request,
  }) => {
    const res = await request.patch(
      `/admin/affiliate/partners/${partner.id}/commission`,
      {
        data: { commissionType: 'percent', commissionRate: 25 },
        headers: auth(admin.accessToken),
      },
    );
    expect(res.ok(), await res.text()).toBeTruthy();

    await referredUserWithOtp({ cost: 10 });
    await runAccrual(request, admin.accessToken);

    const [commission] = await sql<{ amount: string; rateValue: string }>(
      `SELECT "amount", "rateValue" FROM "partner_commissions"`,
    );
    expect(Number(commission.rateValue)).toBe(25);
    expect(Number(commission.amount)).toBe(2.5);
  });

  test('the rate is snapshotted, so a later change never rewrites history', async ({
    request,
  }) => {
    await referredUserWithOtp({ cost: 10 });
    await runAccrual(request, admin.accessToken);

    await updateSettings(request, admin.accessToken, {
      defaultCommissionRate: 50,
    });
    await runAccrual(request, admin.accessToken);

    const [commission] = await sql<{ amount: string; rateValue: string }>(
      `SELECT "amount", "rateValue" FROM "partner_commissions"`,
    );
    expect(Number(commission.rateValue)).toBe(10);
    expect(Number(commission.amount)).toBe(1);
  });

  test('the sweep qualifies a referral once the user has paid', async ({
    request,
  }) => {
    const { user } = await referredUserWithOtp({ cost: 10 });

    let [referral] = await sql<{ status: string }>(
      `SELECT "status" FROM "referrals" WHERE "userId" = $1`,
      [user.id],
    );
    expect(referral.status).toBe('pending');

    await seedCompletedPayment(user.id);
    const run = await runAccrual(request, admin.accessToken);
    expect(run.newlyQualified ?? 1).toBeGreaterThanOrEqual(1);

    [referral] = await sql<{ status: string }>(
      `SELECT "status" FROM "referrals" WHERE "userId" = $1`,
      [user.id],
    );
    expect(referral.status).toBe('qualified');
  });

  test.describe('watermark', () => {
    test('advances on a successful run', async ({ request }) => {
      expect((await readSettings()).lastAccrualAt).toBeNull();

      await runAccrual(request, admin.accessToken);

      const after = (await readSettings()).lastAccrualAt;
      expect(after).not.toBeNull();
      expect(new Date(after as Date).getTime()).toBeLessThanOrEqual(Date.now());
    });

    test('widens the window so an outage longer than the lookback still pays', async ({
      request,
    }) => {
      // The watermark is written directly because no endpoint exposes it, and
      // the settings service caches for 30s — so the API call has to come
      // *after* the raw write, since patching is what drops that cache and
      // makes the new watermark visible to the next run.
      await sql(
        `UPDATE "affiliate_settings" SET "lastAccrualAt" = $1 WHERE "isSingleton" = true`,
        [new Date(Date.now() - 240 * HOUR)],
      );
      // Shrink the lookback to its smallest legal value that still satisfies
      // the interval invariant.
      await updateSettings(request, admin.accessToken, {
        accrualIntervalHours: 1,
        accrualLookbackHours: 1,
      });

      // Delivered 100h ago: far outside the 1h lookback, but inside the gap
      // since the last successful run.
      await referredUserWithOtp({
        cost: 10,
        updatedAt: new Date(Date.now() - 100 * HOUR),
      });

      const run = await runAccrual(request, admin.accessToken);
      expect(run.commissionsCreated).toBe(1);
    });

    test('advances while disabled, so re-enabling cannot back-pay the off period', async ({
      request,
    }) => {
      await runAccrual(request, admin.accessToken);
      await updateSettings(request, admin.accessToken, { isEnabled: false });

      // A run while switched off must still move the watermark forward.
      const before = (await readSettings()).lastAccrualAt as Date;
      await new Promise((r) => setTimeout(r, 1100));
      const skipped = await runAccrual(request, admin.accessToken);
      expect(skipped.skipped).toBe(true);

      const after = (await readSettings()).lastAccrualAt as Date;
      expect(new Date(after).getTime()).toBeGreaterThan(
        new Date(before).getTime(),
      );

      // An OTP delivered during the off period, then the programme comes back.
      const user = await seedCustomer();
      await seedReferral(partner.id, user.id, partner.referralCode);
      await seedDeliveredMessage(user.id, {
        costAmount: 10,
        updatedAt: new Date(Date.now() - 2 * HOUR),
      });
      await updateSettings(request, admin.accessToken, {
        accrualIntervalHours: 1,
        accrualLookbackHours: 1,
        isEnabled: true,
      });

      const run = await runAccrual(request, admin.accessToken);
      // Delivered two hours ago, lookback is one hour, and the watermark has
      // been kept current throughout the shutdown — so it stays unpaid.
      expect(run.commissionsCreated).toBe(0);
    });
  });
});
