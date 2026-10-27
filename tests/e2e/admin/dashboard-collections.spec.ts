import { test, expect } from '@playwright/test';
import { randomUUID } from 'crypto';
import { resetDb, closeDb, sql } from '../helpers/db.js';
import {
  createAdmin,
  createCustomer,
  onboardCustomer,
  auth,
  payload,
  Customer,
} from '../helpers/actors.js';
import { postVerify, seedPayment, verifyBody } from '../payments/helpers.js';
import { errorCode, removeFixtures, topup } from './ops-helpers.js';

/**
 * Collections: money received from customers, on the dashboard.
 *
 * The bug this file exists for: a payment received outside the app and credited
 * by hand never showed in the dashboard's collections, because collections were
 * read from the `payments` table (app checkouts only) while a manual credit is
 * only a wallet ledger row. Collections now come from the ledger, so every way
 * money arrives is one number — but goodwill and promotional credits, which
 * nobody paid for, must stay out of it.
 */

interface Day {
  date: string;
  razorpay: number;
  manual: number;
  total: number;
  count: number;
}
interface CollectionsBody {
  days: Day[];
  totals: {
    total: number;
    razorpay: number;
    manual: number;
    count: number;
    averagePerDay: number;
    bestDay: { date: string; total: number } | null;
  };
  previous: { total: number; count: number };
  growthPercent: number | null;
}

/** IST calendar date `daysAgo` days back, the way the server keys its days. */
const istDate = (daysAgo: number, now = Date.now()) =>
  new Date(now + 5.5 * 3600_000 - daysAgo * 86_400_000)
    .toISOString()
    .slice(0, 10);

test.describe('admin dashboard — collections', () => {
  let admin: Customer;
  let customer: Customer;

  test.beforeEach(async ({ request }) => {
    await resetDb();
    await removeFixtures();
    admin = await createAdmin(request);
    customer = await createCustomer(request);
    await onboardCustomer(customer.id);
  });

  test.afterEach(async () => {
    await removeFixtures();
  });

  test.afterAll(async () => {
    await closeDb();
  });

  const collections = async (
    request: import('@playwright/test').APIRequestContext,
    query = '',
  ) => {
    const res = await request.get(`/admin/dashboard/collections${query}`, {
      headers: auth(admin.accessToken),
    });
    expect(res.status(), await res.text()).toBe(200);
    return payload<CollectionsBody>(res);
  };

  const manualCredit = (
    request: import('@playwright/test').APIRequestContext,
    data: Record<string, unknown>,
  ) =>
    request.post(
      '/admin/wallet/topup',
      topup({ email: customer.email, ...data }, admin.accessToken),
    );

  /** A ledger credit at an exact moment, for the day-boundary cases. */
  async function creditAt(opts: {
    amount: number;
    referenceType: string;
    description?: string;
    at: string;
  }) {
    const [{ id: walletId }] = await sql<{ id: string }>(
      `SELECT "id" FROM "wallets" WHERE "userId" = $1`,
      [customer.id],
    );
    await sql(
      `INSERT INTO "wallet_transactions"
         ("walletId","type","amount","balanceBefore","balanceAfter",
          "referenceType","referenceId","description","createdAt")
       VALUES ($1,'credit',$2,0,$2,$3,$4,$5,$6::timestamptz)`,
      [
        walletId,
        opts.amount,
        opts.referenceType,
        randomUUID(),
        opts.description ?? 'seeded',
        opts.at,
      ],
    );
  }

  test('a payment credited by hand counts as a collection, and a goodwill credit does not', async ({
    request,
  }) => {
    const before = await collections(request, '?days=7');

    const paid = await manualCredit(request, {
      amount: 1000,
      description: 'Payment received — credited to your wallet',
      reason: 'payment',
    });
    expect(paid.status(), await paid.text()).toBe(201);
    for (const reason of ['goodwill', 'promo']) {
      const res = await manualCredit(request, {
        amount: 500,
        description: `Given away (${reason})`,
        reason,
      });
      expect(res.status(), await res.text()).toBe(201);
    }

    const after = await collections(request, '?days=7');
    expect(after.totals.total - before.totals.total).toBe(1000);
    expect(after.totals.manual - before.totals.manual).toBe(1000);
    expect(after.totals.razorpay).toBe(before.totals.razorpay);
    expect(after.totals.count - before.totals.count).toBe(1);

    // And it is the dashboard card's number too, not only the chart's.
    const dash = await request.get('/admin/dashboard', {
      headers: auth(admin.accessToken),
    });
    const { overview } = await payload<{
      overview: Record<string, number>;
    }>(dash);
    expect(overview.collectionsTotal).toBe(1000);
    expect(overview.collectionsToday).toBe(1000);
    expect(overview.collectionsManual).toBe(1000);
    expect(overview.collectionsRazorpay).toBe(0);
    expect(overview.collectionsCount).toBe(1);
  });

  test('a credit made with no reason is not a collection, unless it says it was a payment', async ({
    request,
  }) => {
    // Before the reason existed the screen's own preset wrote "Payment
    // received…" into the description, and that is the only evidence older
    // credits carry. A credit with neither is not counted: overstating revenue
    // is worse than a missed payment, which is visible and fixable.
    await manualCredit(request, { amount: 300, description: 'Something else' });
    expect((await collections(request, '?days=7')).totals.total).toBe(0);

    await manualCredit(request, {
      amount: 700,
      description: 'Payment received — credited to your wallet',
    });
    const body = await collections(request, '?days=7');
    expect(body.totals.total).toBe(700);
    expect(body.totals.manual).toBe(700);
  });

  test('an app checkout counts too, once, at the amount credited and not the amount charged', async ({
    request,
  }) => {
    const seeded = await seedPayment({ userId: customer.id });
    const res = await postVerify(
      request,
      customer.accessToken,
      verifyBody(seeded),
    );
    expect(res.status(), await res.text()).toBe(201);
    // Replayed: still one.
    await postVerify(request, customer.accessToken, verifyBody(seeded));

    const body = await collections(request, '?days=7');
    // ₹1,000 credited; the ₹1,020 the card was charged is not revenue.
    expect(body.totals.razorpay).toBe(1000);
    expect(body.totals.total).toBe(1000);
    expect(body.totals.count).toBe(1);
  });

  test('welcome credits, debits and refunds are never collections', async ({
    request,
  }) => {
    // Registration already wrote a ₹10 welcome credit for this customer.
    await creditAt({
      amount: 50,
      referenceType: 'otp_usage',
      at: new Date().toISOString(),
    });
    expect((await collections(request, '?days=7')).totals.total).toBe(0);
  });

  test('days are IST days: a payment just before midnight and one just after land on different days', async ({
    request,
  }) => {
    const now = Date.now();
    const todayIst = istDate(0, now);
    const yesterdayIst = istDate(1, now);
    const base = (d: string, hhmm: string) => `${d}T${hhmm}:00+05:30`;

    await creditAt({
      amount: 100,
      referenceType: 'payment',
      at: base(yesterdayIst, '23:59'),
    });
    await creditAt({
      amount: 200,
      referenceType: 'payment',
      // 00:00:30 today IST — in the past unless the suite runs in the first
      // half minute after IST midnight; that one run in a day is the cost of
      // asserting the real boundary rather than a mocked clock.
      at: base(todayIst, '00:00').replace(':00+05:30', ':30+05:30'),
    });

    const body = await collections(request, '?days=7');
    const byDate = Object.fromEntries(body.days.map((d) => [d.date, d]));
    expect(byDate[yesterdayIst].razorpay).toBe(100);
    expect(byDate[todayIst].razorpay).toBe(200);
    expect(body.totals.total).toBe(300);
  });

  test('every day in the window is present, oldest first, with zeros where nothing came in', async ({
    request,
  }) => {
    await creditAt({
      amount: 400,
      referenceType: 'admin_payment',
      at: new Date(Date.now() - 3 * 86_400_000).toISOString(),
    });
    const body = await collections(request, '?days=10');
    expect(body.days).toHaveLength(10);
    const dates = body.days.map((d) => d.date);
    expect(dates).toEqual([...dates].sort());
    expect(dates[9]).toBe(istDate(0));
    expect(dates[0]).toBe(istDate(9));
    // Nine empty days and one with money.
    expect(body.days.filter((d) => d.total === 0)).toHaveLength(9);
    expect(body.totals.bestDay?.total).toBe(400);
    expect(body.totals.averagePerDay).toBe(40);
  });

  test('growth compares this period with the one before it', async ({
    request,
  }) => {
    const day = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();
    // Previous 7 days (8–14 days ago): ₹1,000. This 7 days: ₹1,500.
    await creditAt({ amount: 1000, referenceType: 'payment', at: day(10) });
    await creditAt({ amount: 1500, referenceType: 'payment', at: day(2) });

    const body = await collections(request, '?days=7');
    expect(body.previous.total).toBe(1000);
    expect(body.totals.total).toBe(1500);
    expect(body.growthPercent).toBe(50);
  });

  test('with nothing to compare against, growth is null rather than infinite', async ({
    request,
  }) => {
    await creditAt({
      amount: 900,
      referenceType: 'payment',
      at: new Date().toISOString(),
    });
    const body = await collections(request, '?days=7');
    expect(body.previous.total).toBe(0);
    expect(body.growthPercent).toBeNull();
  });

  test('only an admin may read it, and the window is bounded', async ({
    request,
  }) => {
    const anon = await request.get('/admin/dashboard/collections');
    expect(anon.status()).toBe(401);

    const asCustomer = await request.get('/admin/dashboard/collections', {
      headers: auth(customer.accessToken),
    });
    expect(asCustomer.status()).toBe(403);

    for (const q of ['?days=0', '?days=-3', '?days=366', '?days=abc', '?days=1.5', '?days=']) {
      const res = await request.get(`/admin/dashboard/collections${q}`, {
        headers: auth(admin.accessToken),
      });
      expect(res.status(), q).toBe(400);
    }
    // The documented limits themselves are fine.
    for (const q of ['?days=1', '?days=365', '']) {
      const res = await request.get(`/admin/dashboard/collections${q}`, {
        headers: auth(admin.accessToken),
      });
      expect(res.status(), q).toBe(200);
    }
  });

  test("a customer's top-up count and \"Never topped up\" tag follow the same rule", async ({
    request,
  }) => {
    // The second place the same bug lived: each customer's top-up count was
    // read from completed app checkouts only, so someone credited by hand for
    // a payment they had made still showed as "Never topped up" — which is the
    // label that decides who gets chased.
    const overview = async () => {
      const res = await request.get(`/admin/users/${customer.id}/overview`, {
        headers: auth(admin.accessToken),
      });
      expect(res.status(), await res.text()).toBe(200);
      return payload<{
        derivedTags: { key: string }[];
        metrics: { topupCount: number; topupTotal: number } | null;
      }>(res);
    };

    let body = await overview();
    expect(body.derivedTags.map((t) => t.key)).toContain('topup:0');
    expect(body.metrics?.topupCount).toBe(0);

    // Given away: not a top-up.
    await manualCredit(request, {
      amount: 500,
      description: 'Goodwill credit',
      reason: 'goodwill',
    });
    body = await overview();
    expect(body.derivedTags.map((t) => t.key)).toContain('topup:0');
    expect(body.metrics?.topupCount).toBe(0);

    // A payment received and credited by hand: a top-up.
    await manualCredit(request, {
      amount: 1000,
      description: 'Payment received — credited to your wallet',
      reason: 'payment',
    });
    body = await overview();
    expect(body.derivedTags.map((t) => t.key)).toContain('topup:1');
    expect(body.derivedTags.map((t) => t.key)).not.toContain('topup:0');
    expect(body.metrics?.topupCount).toBe(1);
    expect(body.metrics?.topupTotal).toBe(1000);

    // And an app checkout on top: two, ₹2,000.
    const seeded = await seedPayment({ userId: customer.id });
    await postVerify(request, customer.accessToken, verifyBody(seeded));
    body = await overview();
    expect(body.metrics?.topupCount).toBe(2);
    expect(body.metrics?.topupTotal).toBe(2000);
    expect(body.derivedTags.map((t) => t.key)).toContain('topup:2');
  });

  test('an unknown reason is refused and nothing is credited', async ({
    request,
  }) => {
    const res = await manualCredit(request, {
      amount: 100,
      description: 'whatever',
      reason: 'bribe',
    });
    expect(res.status(), await res.text()).toBe(400);
    expect(await errorCode(res)).toBe('VALIDATION_ERROR');
  });

  test('the reconciler still holds back an order an admin credited as a payment', async ({
    request,
  }) => {
    // Crediting a received payment by hand now records 'admin_payment', and the
    // reconciler's guard against paying the same order twice has to know it.
    const seeded = await seedPayment({
      userId: customer.id,
      ageMinutes: 30,
      gatewayPayments: [{ id: 'pay_x', status: 'captured', amount: 1020 }],
    });
    await manualCredit(request, {
      amount: 1000,
      description: 'Payment received — credited to your wallet',
      reason: 'payment',
    });
    const res = await request.post('/admin/payments/reconcile', {
      data: { minAgeMinutes: 0 },
      headers: auth(admin.accessToken),
    });
    const report = await payload<{
      entries: { gatewayOrderId: string; outcome: string }[];
    }>(res);
    expect(report.entries).toEqual([
      expect.objectContaining({
        gatewayOrderId: seeded.orderId,
        outcome: 'manual_review',
      }),
    ]);
  });
});
