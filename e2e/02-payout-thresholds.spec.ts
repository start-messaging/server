import { test, expect } from '@playwright/test';
import { resetDb, closeDb, sql, partnerTotals } from './helpers/db.js';
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
} from './helpers/actors.js';

/**
 * Payout thresholds: who gets paid, when, and how much.
 *
 * The two gates are `minPaidReferrals` (how many referred customers have ever
 * paid) and `minPayoutAmount` (how much is owed). Both are checked by the run
 * and reported by the portal, and the pair disagreeing is the defect class
 * this file exists to pin down.
 */
test.describe('payout thresholds', () => {
  let admin: Customer;
  let partner: Partner;

  test.beforeEach(async ({ request }) => {
    await resetDb();
    admin = await createAdmin(request);
    partner = await createPartner(request);
    await updateSettings(request, admin.accessToken, { isEnabled: true });
    // A payout needs somewhere to send the money.
    await sql(
      `UPDATE "partners"
          SET "payoutMethod" = 'upi', "upiId" = 'test@upi'
        WHERE "id" = $1`,
      [partner.id],
    );
  });

  test.afterAll(async () => {
    await closeDb();
  });

  /**
   * Gives the partner `count` qualified referrals and `earn` rupees of
   * accrued commission, using a flat rate so the arithmetic is exact.
   */
  async function earn(
    request: Parameters<typeof runAccrual>[0],
    { qualified, amount }: { qualified: number; amount: number },
  ) {
    await updateSettings(request, admin.accessToken, {
      defaultCommissionType: 'flat',
      defaultCommissionRate: amount,
    });

    for (let i = 0; i < Math.max(qualified, 1); i += 1) {
      const user = await seedCustomer();
      await seedReferral(
        partner.id,
        user.id,
        partner.referralCode,
        i < qualified ? 'qualified' : 'pending',
      );
      if (i === 0) await seedDeliveredMessage(user.id, { costAmount: 1 });
    }

    await runAccrual(request, admin.accessToken);
  }

  /**
   * Eligibility as the portal sees it. There is no dedicated endpoint — it is
   * folded into the dashboard payload, which is what the partner's "progress
   * to payout" panel renders.
   */
  async function eligibility(request: Parameters<typeof runAccrual>[0]) {
    const res = await request.get('/partner/dashboard', {
      headers: auth(partner.accessToken),
    });
    expect(res.ok(), await res.text()).toBeTruthy();
    const body = await payload<{
      payout: {
        isEligible: boolean;
        reason?: string;
        unpaidEarnings: number;
        qualifiedReferrals: number;
        requiredReferrals: number;
        minPayoutAmount: number;
        hasPayoutDetails: boolean;
      };
    }>(res);
    return body.payout;
  }

  test('below the referral threshold: not eligible and not paid', async ({
    request,
  }) => {
    await updateSettings(request, admin.accessToken, {
      minPaidReferrals: 5,
      minPayoutAmount: 1,
    });
    await earn(request, { qualified: 2, amount: 100 });

    const elig = await eligibility(request);
    expect(elig.isEligible).toBe(false);
    expect(elig.reason).toBe('not_enough_paid_referrals');

    const run = await runPayouts(request, admin.accessToken);
    expect(run.payoutsCreated).toBe(0);
  });

  test('below the amount threshold: not eligible and not paid', async ({
    request,
  }) => {
    await updateSettings(request, admin.accessToken, {
      minPaidReferrals: 1,
      minPayoutAmount: 1000,
    });
    await earn(request, { qualified: 2, amount: 10 });

    const elig = await eligibility(request);
    expect(elig.isEligible).toBe(false);
    expect(elig.reason).toBe('below_minimum_amount');

    const run = await runPayouts(request, admin.accessToken);
    expect(run.payoutsCreated).toBe(0);
  });

  test('both thresholds met: eligible, and the payout matches the ledger', async ({
    request,
  }) => {
    await updateSettings(request, admin.accessToken, {
      minPaidReferrals: 2,
      minPayoutAmount: 50,
    });
    await earn(request, { qualified: 3, amount: 100 });

    const elig = await eligibility(request);
    expect(elig.isEligible).toBe(true);
    expect(elig.unpaidEarnings).toBe(100);

    const run = await runPayouts(request, admin.accessToken);
    expect(run.payoutsCreated).toBe(1);
    expect(run.totalAmount).toBe(100);

    const [payoutRow] = await sql<{ amount: string; status: string }>(
      `SELECT "amount", "status" FROM "partner_payouts" WHERE "partnerId" = $1`,
      [partner.id],
    );
    expect(Number(payoutRow.amount)).toBe(100);

    // The ledger moved with it, and the cache followed the ledger.
    const totals = await partnerTotals(partner.id);
    expect(totals.ledger.unpaid).toBe(0);
    expect(totals.ledger.paid).toBe(100);
    expect(totals.cached).toEqual(totals.ledger);
  });

  test('exactly at the thresholds counts as meeting them', async ({
    request,
  }) => {
    await updateSettings(request, admin.accessToken, {
      minPaidReferrals: 2,
      minPayoutAmount: 100,
    });
    await earn(request, { qualified: 2, amount: 100 });

    expect((await eligibility(request)).isEligible).toBe(true);
    expect((await runPayouts(request, admin.accessToken)).payoutsCreated).toBe(
      1,
    );
  });

  test('eligibility and the run agree even when the cached balance drifts', async ({
    request,
  }) => {
    await updateSettings(request, admin.accessToken, {
      minPaidReferrals: 1,
      minPayoutAmount: 50,
    });
    await earn(request, { qualified: 2, amount: 100 });

    // Corrupt the cache the way real drift would: it now claims far more than
    // the ledger holds. Selecting candidates on this column used to let a
    // below-minimum balance through and pay the (smaller) ledger sum anyway.
    await sql(
      `UPDATE "partners" SET "unpaidEarnings" = 99999 WHERE "id" = $1`,
      [partner.id],
    );

    const elig = await eligibility(request);
    // The portal reads the ledger, so it reports the truth.
    expect(elig.unpaidEarnings).toBe(100);

    const run = await runPayouts(request, admin.accessToken);
    expect(run.payoutsCreated).toBe(1);

    const [payoutRow] = await sql<{ amount: string }>(
      `SELECT "amount" FROM "partner_payouts" WHERE "partnerId" = $1`,
      [partner.id],
    );
    // Never the inflated cache figure.
    expect(Number(payoutRow.amount)).toBe(100);
  });

  test('a cache reading low does not hide an eligible partner from the run', async ({
    request,
  }) => {
    await updateSettings(request, admin.accessToken, {
      minPaidReferrals: 1,
      minPayoutAmount: 50,
    });
    await earn(request, { qualified: 2, amount: 100 });

    // Understated cache: the run used to filter on this and skip the partner
    // entirely, while the portal kept telling them they were eligible.
    await sql(`UPDATE "partners" SET "unpaidEarnings" = 0 WHERE "id" = $1`, [
      partner.id,
    ]);

    expect((await eligibility(request)).isEligible).toBe(true);

    const run = await runPayouts(request, admin.accessToken);
    expect(run.payoutsCreated).toBe(1);
    expect(run.totalAmount).toBe(100);
  });

  test('a below-minimum balance is never paid, even if selected', async ({
    request,
  }) => {
    await updateSettings(request, admin.accessToken, {
      minPaidReferrals: 1,
      minPayoutAmount: 1000,
    });
    await earn(request, { qualified: 2, amount: 10 });

    // Inflated cache would have selected this partner; the amount check under
    // the row lock is what stops a 10-rupee payout against a 1000 minimum.
    await sql(
      `UPDATE "partners" SET "unpaidEarnings" = 99999 WHERE "id" = $1`,
      [partner.id],
    );

    const run = await runPayouts(request, admin.accessToken);
    expect(run.payoutsCreated).toBe(0);

    const [{ count }] = await sql<{ count: string }>(
      `SELECT COUNT(*)::int AS count FROM "partner_payouts"`,
    );
    expect(Number(count)).toBe(0);
  });

  test('a partner with no payout destination is skipped, not settled', async ({
    request,
  }) => {
    await updateSettings(request, admin.accessToken, {
      minPaidReferrals: 1,
      minPayoutAmount: 10,
    });
    await earn(request, { qualified: 2, amount: 100 });

    await sql(
      `UPDATE "partners"
          SET "payoutMethod" = NULL, "upiId" = NULL, "bankAccountNumber" = NULL
        WHERE "id" = $1`,
      [partner.id],
    );

    // The portal must say so too. Reporting "both conditions met" here and
    // then paying nothing is how a partner discovers on the 25th that they
    // lost the cycle to a blank field.
    const elig = await eligibility(request);
    expect(elig.hasPayoutDetails).toBe(false);
    expect(elig.isEligible).toBe(false);
    expect(elig.reason).toBe('missing_payout_details');

    const run = await runPayouts(request, admin.accessToken);
    expect(run.payoutsCreated).toBe(0);

    // Critically, the money must still be owed — not marked paid into nowhere.
    const totals = await partnerTotals(partner.id);
    expect(totals.ledger.unpaid).toBe(100);
    expect(totals.ledger.paid).toBe(0);
  });

  test('a bank partner missing an IFSC is skipped', async ({ request }) => {
    await updateSettings(request, admin.accessToken, {
      minPaidReferrals: 1,
      minPayoutAmount: 10,
    });
    await earn(request, { qualified: 2, amount: 100 });

    await sql(
      `UPDATE "partners"
          SET "payoutMethod" = 'bank', "upiId" = NULL,
              "bankAccountNumber" = '123456789', "bankIfsc" = NULL
        WHERE "id" = $1`,
      [partner.id],
    );

    // A half-filled bank destination is no destination: the portal must not
    // count it, exactly as the run does not.
    const elig = await eligibility(request);
    expect(elig.hasPayoutDetails).toBe(false);
    expect(elig.reason).toBe('missing_payout_details');

    expect((await runPayouts(request, admin.accessToken)).payoutsCreated).toBe(
      0,
    );
  });

  test('the payout records the instrument actually being paid', async ({
    request,
  }) => {
    await updateSettings(request, admin.accessToken, {
      minPaidReferrals: 1,
      minPayoutAmount: 10,
    });
    await earn(request, { qualified: 2, amount: 100 });

    // A partner who used UPI first and later switched to bank keeps the stale
    // upiId; the snapshot must follow payoutMethod, not whichever is populated.
    await sql(
      `UPDATE "partners"
          SET "payoutMethod" = 'bank',
              "upiId" = 'stale@upi',
              "bankAccountName" = 'Test Partner',
              "bankAccountNumber" = '999988887777',
              "bankIfsc" = 'HDFC0001234'
        WHERE "id" = $1`,
      [partner.id],
    );

    await runPayouts(request, admin.accessToken);

    const [row] = await sql<{
      payoutMethod: string;
      payoutAccountRef: string;
    }>(
      `SELECT "payoutMethod", "payoutAccountRef" FROM "partner_payouts" WHERE "partnerId" = $1`,
      [partner.id],
    );
    expect(row.payoutMethod).toBe('bank');
    expect(row.payoutAccountRef).toContain('7777');
    expect(row.payoutAccountRef).not.toContain('upi');
  });

  test('one payout per partner per period, however often the run fires', async ({
    request,
  }) => {
    await updateSettings(request, admin.accessToken, {
      minPaidReferrals: 1,
      minPayoutAmount: 10,
    });
    await earn(request, { qualified: 2, amount: 100 });

    const first = await runPayouts(request, admin.accessToken);
    const second = await runPayouts(request, admin.accessToken);
    const third = await runPayouts(request, admin.accessToken);

    expect(first.payoutsCreated).toBe(1);
    expect(second.payoutsCreated).toBe(0);
    expect(third.payoutsCreated).toBe(0);

    const [{ count }] = await sql<{ count: string }>(
      `SELECT COUNT(*)::int AS count FROM "partner_payouts" WHERE "partnerId" = $1`,
      [partner.id],
    );
    expect(Number(count)).toBe(1);

    const totals = await partnerTotals(partner.id);
    expect(totals.ledger.paid).toBe(100);
  });

  test('a suspended partner is not paid', async ({ request }) => {
    await updateSettings(request, admin.accessToken, {
      minPaidReferrals: 1,
      minPayoutAmount: 10,
    });
    await earn(request, { qualified: 2, amount: 100 });
    await sql(`UPDATE "partners" SET "status" = 'suspended' WHERE "id" = $1`, [
      partner.id,
    ]);

    // Read through the admin surface, not the partner dashboard: the partner
    // JWT strategy rejects a suspended token outright, so `partner_not_active`
    // is only ever observable by an admin looking at the account.
    const detail = await request.get(
      `/admin/affiliate/partners/${partner.id}`,
      { headers: auth(admin.accessToken) },
    );
    expect(detail.ok(), await detail.text()).toBeTruthy();
    const { payout: elig } = await payload<{
      payout: { isEligible: boolean; reason?: string };
    }>(detail);
    expect(elig.isEligible).toBe(false);
    expect(elig.reason).toBe('partner_not_active');

    expect((await runPayouts(request, admin.accessToken)).payoutsCreated).toBe(
      0,
    );
  });

  test('the run is a no-op while the programme is disabled', async ({
    request,
  }) => {
    await updateSettings(request, admin.accessToken, {
      minPaidReferrals: 1,
      minPayoutAmount: 10,
    });
    await earn(request, { qualified: 2, amount: 100 });
    await updateSettings(request, admin.accessToken, { isEnabled: false });

    const run = await runPayouts(request, admin.accessToken);
    expect(run.skipped).toBe(true);
    expect(run.payoutsCreated).toBe(0);
  });
});
