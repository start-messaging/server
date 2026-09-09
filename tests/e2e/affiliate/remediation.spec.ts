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
  Customer,
  Partner,
} from '../helpers/actors.js';

/**
 * Fraud and chargeback remediation.
 *
 * REVERSED and BLOCKED existed in both the TypeScript and Postgres enums, and
 * the accrual query already skipped blocked referrals, but nothing ever wrote
 * either value — so a fraudulent referral kept earning and got paid. These are
 * the paths that write them.
 */
test.describe('remediation', () => {
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

  /** One qualified referral with one accrued commission of 100. */
  async function earning(request: APIRequestContext) {
    const user = await seedCustomer();
    const referralId = await seedReferral(
      partner.id,
      user.id,
      partner.referralCode,
      'qualified',
    );
    await seedDeliveredMessage(user.id, { costAmount: 1 });
    await runAccrual(request, admin.accessToken);

    const [commission] = await sql<{ id: string }>(
      `SELECT "id" FROM "partner_commissions" WHERE "referralId" = $1`,
      [referralId],
    );
    return { user, referralId, commissionId: commission.id };
  }

  test.describe('reversing a commission', () => {
    test('takes the money back off the balance', async ({ request }) => {
      const { commissionId } = await earning(request);
      expect((await partnerTotals(partner.id)).ledger.unpaid).toBe(100);

      const res = await request.patch(
        `/admin/affiliate/commissions/${commissionId}/reverse`,
        {
          data: { reason: 'Customer charged back the payment' },
          headers: auth(admin.accessToken),
        },
      );
      expect(res.ok(), await res.text()).toBeTruthy();

      const [row] = await sql<{ status: string; reversedReason: string }>(
        `SELECT "status", "reversedReason" FROM "partner_commissions" WHERE "id" = $1`,
        [commissionId],
      );
      expect(row.status).toBe('reversed');
      expect(row.reversedReason).toBe('Customer charged back the payment');

      const totals = await partnerTotals(partner.id);
      expect(totals.ledger.unpaid).toBe(0);
      expect(totals.ledger.lifetime).toBe(0);
      expect(totals.cached).toEqual(totals.ledger);
    });

    test('requires a reason', async ({ request }) => {
      const { commissionId } = await earning(request);

      const missing = await request.patch(
        `/admin/affiliate/commissions/${commissionId}/reverse`,
        { data: {}, headers: auth(admin.accessToken) },
      );
      expect(missing.status()).toBe(400);

      const tooShort = await request.patch(
        `/admin/affiliate/commissions/${commissionId}/reverse`,
        { data: { reason: 'x' }, headers: auth(admin.accessToken) },
      );
      expect(tooShort.status()).toBe(400);
    });

    test('is idempotent', async ({ request }) => {
      const { commissionId } = await earning(request);

      await request.patch(
        `/admin/affiliate/commissions/${commissionId}/reverse`,
        { data: { reason: 'Fraudulent signup' }, headers: auth(admin.accessToken) },
      );
      const afterFirst = await partnerTotals(partner.id);

      const second = await request.patch(
        `/admin/affiliate/commissions/${commissionId}/reverse`,
        { data: { reason: 'Fraudulent signup' }, headers: auth(admin.accessToken) },
      );
      expect(second.ok(), await second.text()).toBeTruthy();

      expect((await partnerTotals(partner.id)).ledger).toEqual(
        afterFirst.ledger,
      );
      expect((await partnerTotals(partner.id)).cached.unpaid).toBe(0);
    });

    test('refuses a commission already paid out', async ({ request }) => {
      const { commissionId } = await earning(request);
      await runPayouts(request, admin.accessToken);

      const res = await request.patch(
        `/admin/affiliate/commissions/${commissionId}/reverse`,
        {
          data: { reason: 'Too late, already sent' },
          headers: auth(admin.accessToken),
        },
      );
      expect(res.status()).toBe(400);

      // The ledger still says paid — no silent rewrite of settled money.
      const [row] = await sql<{ status: string }>(
        `SELECT "status" FROM "partner_commissions" WHERE "id" = $1`,
        [commissionId],
      );
      expect(row.status).toBe('paid');
    });

    test('a reversed commission is never swept into a payout', async ({
      request,
    }) => {
      const { commissionId } = await earning(request);
      await request.patch(
        `/admin/affiliate/commissions/${commissionId}/reverse`,
        { data: { reason: 'Chargeback' }, headers: auth(admin.accessToken) },
      );

      const run = await runPayouts(request, admin.accessToken);
      expect(run.payoutsCreated).toBe(0);
    });

    test('rejects a non-admin', async ({ request }) => {
      const { commissionId } = await earning(request);

      const asPartner = await request.patch(
        `/admin/affiliate/commissions/${commissionId}/reverse`,
        { data: { reason: 'trying it on' }, headers: auth(partner.accessToken) },
      );
      expect([401, 403]).toContain(asPartner.status());

      const anonymous = await request.patch(
        `/admin/affiliate/commissions/${commissionId}/reverse`,
        { data: { reason: 'trying it on' } },
      );
      expect([401, 403]).toContain(anonymous.status());
    });
  });

  test.describe('blocking a referral', () => {
    test('stops future earnings and claws back the unpaid ones', async ({
      request,
    }) => {
      const { referralId, user } = await earning(request);

      const res = await request.patch(
        `/admin/affiliate/referrals/${referralId}/block`,
        {
          data: { reason: 'Self-referral from a second address' },
          headers: auth(admin.accessToken),
        },
      );
      expect(res.ok(), await res.text()).toBeTruthy();

      const [referral] = await sql<{ status: string; blockedReason: string }>(
        `SELECT "status", "blockedReason" FROM "referrals" WHERE "id" = $1`,
        [referralId],
      );
      expect(referral.status).toBe('blocked');
      expect(referral.blockedReason).toBe('Self-referral from a second address');

      // Existing balance is gone...
      expect((await partnerTotals(partner.id)).ledger.unpaid).toBe(0);

      // ...and new traffic from that user earns nothing.
      await seedDeliveredMessage(user.id, { costAmount: 1 });
      const run = await runAccrual(request, admin.accessToken);
      expect(run.commissionsCreated).toBe(0);
    });

    test('reports commissions it could not claw back', async ({ request }) => {
      const { referralId } = await earning(request);
      await runPayouts(request, admin.accessToken);

      const res = await request.patch(
        `/admin/affiliate/referrals/${referralId}/block`,
        { data: { reason: 'Fraud found later' }, headers: auth(admin.accessToken) },
      );
      expect(res.ok(), await res.text()).toBeTruthy();

      const body = (await res.json()) as {
        data: { reversed: number; alreadyPaid: number };
      };
      expect(body.data.reversed).toBe(0);
      expect(body.data.alreadyPaid).toBe(1);
    });

    test('requires a reason', async ({ request }) => {
      const { referralId } = await earning(request);
      const res = await request.patch(
        `/admin/affiliate/referrals/${referralId}/block`,
        { data: {}, headers: auth(admin.accessToken) },
      );
      expect(res.status()).toBe(400);
    });

    test('404s on an unknown referral rather than failing silently', async ({
      request,
    }) => {
      const res = await request.patch(
        `/admin/affiliate/referrals/00000000-0000-4000-8000-000000000000/block`,
        { data: { reason: 'does not exist' }, headers: auth(admin.accessToken) },
      );
      expect(res.status()).toBe(404);
    });
  });
});
