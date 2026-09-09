import { test, expect } from '@playwright/test';
import { resetDb, closeDb, sql } from '../helpers/db.js';
import {
  createAdmin,
  createCustomer,
  onboardCustomer,
  seedCompletedPayment,
  seedCustomer,
  seedDeliveredMessage,
  auth,
  payload,
  Customer,
} from '../helpers/actors.js';
import { seedLedger } from '../helpers/wallet.js';
import { removeFixtures } from './ops-helpers.js';

/** The IST calendar date of an instant, the same way every trend query buckets. */
function istDate(at: Date): string {
  return new Date(at.getTime() + 5.5 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The admin dashboard: the headline counts, and the revenue figures behind them.
 *
 * admin/overview.spec.ts walks the happy path of this route. This file goes after
 * the seams instead — the account that is counted but is not active, and the
 * difference between money paid in and money earned.
 */

test.describe('admin ops — dashboard', () => {
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

  test('the headline counts include every account, and count only live ones as active', async ({
    request,
  }) => {
    // Four accounts by the end: the admin, the onboarded customer, and the two
    // made here. countAll() has no role filter, so the admin counts itself —
    // that is what the number on the panel means, and it should not drift.
    const dormant = await createCustomer(request);
    await sql(`UPDATE "users" SET "isActive" = false WHERE "id" = $1`, [
      dormant.id,
    ]);
    const applicant = await createCustomer(request);
    await sql(`UPDATE "users" SET "kycStatus" = 'pending' WHERE "id" = $1`, [
      applicant.id,
    ]);

    const res = await request.get('/admin/dashboard', {
      headers: auth(admin.accessToken),
    });
    expect(res.status(), await res.text()).toBe(200);

    const body = await payload<{
      overview: {
        totalUsers: number;
        activeUsers: number;
        totalMessages: number;
        pendingKycCount: number;
      };
    }>(res);

    expect(body.overview.totalUsers).toBe(4);
    expect(body.overview.activeUsers).toBe(3);
    expect(body.overview.pendingKycCount).toBe(1);
    expect(body.overview.totalMessages).toBe(0);
  });

  test('money paid in is not counted as money earned', async ({ request }) => {
    // `totalRevenue` sums wallet DEBITs, because the platform earns when a
    // customer spends, not when they top up. Two welcome credits of ₹10 (the
    // admin's and the customer's) are sitting in the ledger as CREDITs at this
    // point: if the sign were ever dropped from that query, revenue would read
    // 20 instead of 0.
    await seedCompletedPayment(customer.id, 500);
    await seedCompletedPayment(customer.id, 250.5);

    const res = await request.get('/admin/dashboard', {
      headers: auth(admin.accessToken),
    });
    const body = await payload<{
      overview: {
        totalRevenue: number;
        razorpayPaymentsTotal: number;
        razorpayPaymentsToday: number;
        razorpayPaymentsCount: number;
      };
      performance: { revenueToday: number; successRate: number };
    }>(res);

    expect(body.overview.totalRevenue).toBe(0);
    expect(body.performance.revenueToday).toBe(0);
    expect(body.overview.razorpayPaymentsTotal).toBe(750.5);
    expect(body.overview.razorpayPaymentsToday).toBe(750.5);
    expect(body.overview.razorpayPaymentsCount).toBe(2);
    // No messages at all is a 0% success rate, not a division by zero.
    expect(body.performance.successRate).toBe(0);
  });

  test('the seven-day trends bucket messages and revenue on IST days, as numbers', async ({
    request,
  }) => {
    // Half the response contract lives in `trends`, and nothing else asserts
    // it. Both queries bucket on `createdAt AT TIME ZONE 'Asia/Kolkata'` and
    // cut off at midnight IST seven days back, so the seeds sit today, three
    // days ago (inside the window on a different day), and eight days ago
    // (which must not appear at all).
    const now = new Date();
    const threeDaysAgo = new Date(now.getTime() - 3 * DAY_MS);
    const eightDaysAgo = new Date(now.getTime() - 8 * DAY_MS);

    await seedDeliveredMessage(customer.id, { updatedAt: now });
    await seedDeliveredMessage(customer.id, { updatedAt: now });
    await seedDeliveredMessage(customer.id, { updatedAt: now, status: 'failed' });
    await seedDeliveredMessage(customer.id, { updatedAt: threeDaysAgo });
    await seedDeliveredMessage(customer.id, { updatedAt: eightDaysAgo });

    // Revenue is DEBITs only — the welcome credits sitting in the same ledger
    // are the control. 0.75 and 1.25 are exact in binary, so the numeric
    // assertion is byte-honest.
    // The top-up is not decoration. These four debits total ₹11 against a
    // wallet that opened on the ₹10 welcome credit; the hand-written insert
    // they replace hid that by giving all four rows balanceBefore = 10, a
    // history in which three of the four never happened. Chained honestly they
    // take the wallet to −1, which performReferencedDebit refuses outright
    // (wallet.service.ts:341), so the account is funded first. Both trend
    // queries are SUM(amount) grouped by day over type='debit' and read
    // neither credits nor balanceBefore, so the figures asserted below are the
    // same either way.
    await seedLedger(
      customer.id,
      { to: 20, description: 'e2e trend seed funding' },
      { delta: -0.25, description: 'e2e trend seed', createdAt: now },
      { delta: -0.5, description: 'e2e trend seed', createdAt: now },
      { delta: -1.25, description: 'e2e trend seed', createdAt: threeDaysAgo },
      { delta: -9, description: 'e2e trend seed', createdAt: eightDaysAgo },
    );

    const res = await request.get('/admin/dashboard', {
      headers: auth(admin.accessToken),
    });
    expect(res.status(), await res.text()).toBe(200);
    const body = await payload<{
      trends: {
        messages: {
          date: string;
          total: number;
          delivered: number;
          failed: number;
        }[];
        revenue: { date: string; revenue: number }[];
      };
    }>(res);

    // Days with no traffic produce no row (there is no zero-filling), and the
    // series runs oldest first — asserted with deep equality so a dropped
    // bucket, a UTC day boundary, or a numeric string all fail loudly.
    expect(body.trends.messages).toEqual([
      { date: istDate(threeDaysAgo), total: 1, delivered: 1, failed: 0 },
      { date: istDate(now), total: 3, delivered: 2, failed: 1 },
    ]);
    expect(body.trends.revenue).toEqual([
      { date: istDate(threeDaysAgo), revenue: 1.25 },
      { date: istDate(now), revenue: 0.75 },
    ]);
  });

  test('growth counts new accounts against IST day and week boundaries', async ({
    request,
  }) => {
    // growth.newUsersToday / newUsersThisWeek are asserted nowhere else. The
    // admin and the customer registered moments ago; the two seeded rows are
    // backdated to three and ten days, so today, the week window, and the far
    // side of it each hold a known count.
    const insideWeek = await seedCustomer();
    await sql(
      `UPDATE "users" SET "createdAt" = now() - interval '3 days' WHERE "id" = $1`,
      [insideWeek.id],
    );
    const outsideWeek = await seedCustomer();
    await sql(
      `UPDATE "users" SET "createdAt" = now() - interval '10 days' WHERE "id" = $1`,
      [outsideWeek.id],
    );

    const res = await request.get('/admin/dashboard', {
      headers: auth(admin.accessToken),
    });
    expect(res.status(), await res.text()).toBe(200);
    const body = await payload<{
      overview: { totalUsers: number };
      growth: { newUsersToday: number; newUsersThisWeek: number };
    }>(res);

    expect(body.overview.totalUsers).toBe(4);
    expect(body.growth.newUsersToday).toBe(2);
    // Today's two plus the three-day-old row; the ten-day-old one is the
    // control that proves the week window has a far edge.
    expect(body.growth.newUsersThisWeek).toBe(3);
  });
});
