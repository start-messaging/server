import { test, expect } from '@playwright/test';
import { resetDb, closeDb } from '../helpers/db.js';
import {
  createCustomer,
  onboardCustomer,
  seedDeliveredMessage,
  auth,
  payload,
  Customer,
} from '../helpers/actors.js';
import { daysAgo, errorOf, istToday, seedSpread, Stats } from './helpers.js';

/**
 * The seams around the customer dashboard (`/dashboard`).
 *
 * The controller is thin, and everything that can go wrong lives just
 * underneath it: a query DTO that decides what reaches Postgres, and a
 * hand-written projection that decides what the customer is allowed to see.
 *
 * This file also owns the onboarding gate that covers both the message history
 * and the whole dashboard — the guard the other messages specs start past.
 */
test.describe('messages and dashboard edge cases', () => {
  let customer: Customer;

  test.beforeEach(async ({ request }) => {
    await resetDb();
    customer = await createCustomer(request);
    // Both controllers sit behind the global OnboardingGuard, so an
    // un-onboarded account cannot reach either of them. That gate has its own
    // test at the bottom of this file; everything else starts past it.
    await onboardCustomer(customer.id);
  });

  test.afterAll(async () => {
    await closeDb();
  });

  test.describe('dashboard stats and trends', () => {
    test('stats count today by default and the whole history in the total', async ({
      request,
    }) => {
      await seedSpread(customer.id);

      const res = await request.get('/dashboard/stats', {
        headers: auth(customer.accessToken),
      });
      expect(res.status(), await res.text()).toBe(200);

      const body = await payload<Stats>(res);
      // Five messages created today; the nine-day-old one is outside the
      // default window but still part of the lifetime total.
      expect(body.filtered.requested).toBe(5);
      expect(body.filtered.delivered).toBe(3);
      expect(body.filtered.failed).toBe(1);
      // Exactly three delivered messages at 0.25. The 5.00 on the `sent` row is
      // not revenue and must not appear here.
      expect(body.filtered.cost).toBe(0.75);
      expect(body.total.messages).toBe(6);
      expect(body.total.cost).toBe(1.75);

      // Numeric, not numeric strings — these are summed client-side, and a
      // string would concatenate. Checked on the nested values, which is where
      // the numbers actually live.
      for (const value of [
        body.filtered.requested,
        body.filtered.cost,
        body.total.messages,
        body.total.cost,
      ]) {
        expect(typeof value).toBe('number');
      }
    });

    test('an explicit range widens what is counted but never the lifetime total', async ({
      request,
    }) => {
      await seedSpread(customer.id);

      const res = await request.get(
        `/dashboard/stats?startDate=${daysAgo(30).toISOString()}&endDate=${new Date().toISOString()}`,
        { headers: auth(customer.accessToken) },
      );
      expect(res.status(), await res.text()).toBe(200);

      const body = await payload<Stats>(res);
      expect(body.filtered.requested).toBe(6);
      expect(body.filtered.delivered).toBe(4);
      expect(body.filtered.cost).toBe(1.75);
      expect(body.total.messages).toBe(6);
      expect(body.total.cost).toBe(1.75);
    });

    test('a range that ends before it starts reports zeroes, not an error', async ({
      request,
    }) => {
      await seedSpread(customer.id);

      const res = await request.get(
        '/dashboard/stats?startDate=2026-06-01T00:00:00.000Z&endDate=2026-01-01T00:00:00.000Z',
        { headers: auth(customer.accessToken) },
      );
      expect(res.status(), await res.text()).toBe(200);

      const body = await payload<Stats>(res);
      expect(body.filtered.requested).toBe(0);
      expect(body.filtered.delivered).toBe(0);
      // COALESCE, so an empty range is 0 rather than null — a null here would
      // render as "NaN" on the dashboard tile.
      expect(body.filtered.cost).toBe(0);
      expect(body.total.messages).toBe(6);
    });

    test('a malformed date on the stats route is refused', async ({
      request,
    }) => {
      for (const qs of ['startDate=nope', 'endDate=2026-13-01', 'startDate=']) {
        const res = await request.get(`/dashboard/stats?${qs}`, {
          headers: auth(customer.accessToken),
        });
        expect(res.status(), `"${qs}" was accepted`).toBe(400);
      }
    });

    test('another customer traffic never enters my stats or trends', async ({
      request,
    }) => {
      const other = await createCustomer(request);
      await onboardCustomer(other.id);
      await seedSpread(other.id);
      await seedDeliveredMessage(customer.id, { costAmount: 0.25 });

      const stats = await payload<Stats>(
        await request.get('/dashboard/stats', {
          headers: auth(customer.accessToken),
        }),
      );
      expect(stats.total.messages).toBe(1);
      expect(stats.total.cost).toBe(0.25);
      expect(stats.filtered.cost).toBe(0.25);

      const trends = await payload<{ total: number }[]>(
        await request.get('/dashboard/trends', {
          headers: auth(customer.accessToken),
        }),
      );
      expect(trends.reduce((sum, row) => sum + row.total, 0)).toBe(1);
    });

    test('trends are ordered oldest first and carry numbers, not strings', async ({
      request,
    }) => {
      await seedDeliveredMessage(customer.id, { costAmount: 0.25 });
      await seedDeliveredMessage(customer.id, { costAmount: 0.25 });
      await seedDeliveredMessage(customer.id, {
        status: 'failed',
        costAmount: 0,
      });
      await seedDeliveredMessage(customer.id, {
        costAmount: 0.25,
        updatedAt: daysAgo(3),
      });

      const res = await request.get('/dashboard/trends?days=7', {
        headers: auth(customer.accessToken),
      });
      expect(res.status(), await res.text()).toBe(200);

      const rows =
        await payload<
          { date: string; total: number; delivered: number; failed: number }[]
        >(res);
      expect(rows.length).toBe(2);
      // A graph drawn from an unsorted series draws a zigzag.
      expect(rows.map((r) => r.date)).toEqual(
        [...rows.map((r) => r.date)].sort(),
      );

      const today = rows.find((r) => r.date === istToday());
      expect(
        today,
        `no bucket for ${istToday()} in ${JSON.stringify(rows)}`,
      ).toBeTruthy();
      expect(today!.total).toBe(3);
      expect(today!.delivered).toBe(2);
      expect(today!.failed).toBe(1);
      for (const value of [today!.total, today!.delivered, today!.failed]) {
        expect(typeof value).toBe('number');
      }
    });

    test('an unusable day count falls back to a week rather than erroring', async ({
      request,
    }) => {
      // The `|| 7` this used to pin now lives in DashboardTrendsQueryDto's
      // transform: a non-numeric value, 0, and an empty `?days=` all resolve to
      // the default before the range validators see them. Delete that fallback
      // and these three become a 400 instead — @IsInt rejects the NaN that
      // implicit conversion produces — which is safe but turns a link somebody
      // truncated when they pasted it into an error page rather than a chart.
      // The fallback, not the range check, is what this test owns.
      await seedDeliveredMessage(customer.id, {
        costAmount: 0.25,
        updatedAt: daysAgo(3),
      });

      for (const days of ['abc', '0', '']) {
        const res = await request.get(
          `/dashboard/trends?days=${encodeURIComponent(days)}`,
          { headers: auth(customer.accessToken) },
        );
        expect(res.status(), `days=${days}: ${await res.text()}`).toBe(200);

        const rows = await payload<{ total: number }[]>(res);
        expect(
          rows.reduce((sum, row) => sum + row.total, 0),
          `days=${days} did not fall back to a week`,
        ).toBe(1);
      }
    });

    test('a negative day count reports nothing rather than everything', async ({
      request,
    }) => {
      // A negative shift moves the window start into the future, which must
      // match nothing — the dangerous failure would be treating it as
      // "unbounded" and returning the full history.
      await seedDeliveredMessage(customer.id, { costAmount: 0.25 });

      const res = await request.get('/dashboard/trends?days=-5', {
        headers: auth(customer.accessToken),
      });
      expect(res.status(), await res.text()).toBe(200);
      expect(await payload<unknown[]>(res)).toEqual([]);
    });

    test('an absurd day count is a bad request, not a server error', async ({
      request,
    }) => {
      // `days` is bounded by DashboardTrendsQueryDto (@IsInt/@Min/@Max, ceiling
      // 366 — a year of daily buckets), so an out-of-range value is refused at
      // the edge and never reaches a Date. It used to be a bare @Query typed
      // `number`: ValidationPipe coerced it with `+value`, nothing checked the
      // range, istDayStart(1e9) pushed setUTCDate() past the ±100,000,000-day
      // Date range and yielded an Invalid Date, pg serialised that to the
      // literal "0NaN-NaN-NaNTNaN:NaN:NaN.NaN+NaN:NaN", Postgres rejected it,
      // and the QueryFailedError — not an HttpException — reached
      // AllExceptionsFilter as a 500 INTERNAL_ERROR.
      //
      // A query parameter must never be able to fault the server, so the
      // assertion stays as it is; do not relax it to `toBeLessThan(600)`.
      const res = await request.get('/dashboard/trends?days=1000000000', {
        headers: auth(customer.accessToken),
      });
      expect(res.status(), await res.text()).toBeLessThan(500);
    });

    test('the dashboard key list is scoped to the caller', async ({
      request,
    }) => {
      // Only the ownership filter is asserted here. That this route never
      // echoes the plaintext key is already pinned by api-keys/secret
      // ("nothing a later read returns can be replayed as a credential",
      // whose loop includes /dashboard/api-keys), so repeating it would just
      // give the same defect two places to be weakened from.
      const created = await request.post('/api-keys', {
        data: { label: 'mine' },
        headers: auth(customer.accessToken),
      });
      expect(created.ok(), await created.text()).toBeTruthy();
      const mine = await payload<{ id: string }>(created);

      const other = await createCustomer(request);
      await onboardCustomer(other.id);
      await request.post('/api-keys', {
        data: { label: 'theirs' },
        headers: auth(other.accessToken),
      });

      const res = await request.get('/dashboard/api-keys', {
        headers: auth(customer.accessToken),
      });
      expect(res.status(), await res.text()).toBe(200);

      const rows = await payload<{ id: string; userId: string }[]>(res);
      expect(rows.length).toBe(1);
      expect(rows[0].id).toBe(mine.id);
      expect(rows[0].userId).toBe(customer.id);
    });

    test('the usage guide hands out a placeholder, not a real key', async ({
      request,
    }) => {
      // A different handler from /api-keys/usage-guide (which api-keys/secret
      // covers): this one is a bare `generateUsageGuide('YOUR_API_KEY')` with
      // no service call, so nothing stops a future edit threading the caller's
      // key through it the way the create response does.
      const created = await request.post('/api-keys', {
        data: { label: 'mine' },
        headers: auth(customer.accessToken),
      });
      expect(created.ok(), await created.text()).toBeTruthy();
      const { key: plaintext } = await payload<{ key: string }>(created);

      const res = await request.get('/dashboard/usage-guide', {
        headers: auth(customer.accessToken),
      });
      expect(res.status(), await res.text()).toBe(200);

      const text = JSON.stringify(await payload(res));
      expect(text).toContain('YOUR_API_KEY');
      expect(text, 'the usage guide embedded a live key').not.toContain(
        plaintext,
      );
    });

    test('the onboarding gate covers the history and the whole dashboard', async ({
      request,
    }) => {
      // A freshly registered account has not verified a mobile number, so the
      // global guard refuses it everywhere on these two controllers — including
      // the static usage guide, which is documentation rather than data.
      const fresh = await createCustomer(request);

      for (const path of [
        '/messages',
        '/dashboard/stats',
        '/dashboard/trends',
        '/dashboard/api-keys',
        '/dashboard/usage-guide',
      ]) {
        const res = await request.get(path, {
          headers: auth(fresh.accessToken),
        });
        expect(
          res.status(),
          `${path} was open to an un-onboarded account`,
        ).toBe(403);
        // The guard knows exactly which step is outstanding; the client is
        // told, at minimum, in the message.
        expect((await errorOf(res)).message).toMatch(/verification|KYC/i);
      }
    });
  });
});
