import { test, expect } from '@playwright/test';
import { resetDb, closeDb } from '../helpers/db.js';
import {
  createAdmin,
  createCustomer,
  onboardCustomer,
  seedDeliveredMessage,
  auth,
  payload,
  Customer,
} from '../helpers/actors.js';
import { errorCode, pagination, removeFixtures } from './ops-helpers.js';

/**
 * The admin daily usage report.
 *
 * admin/overview.spec.ts walks the happy path of this route. This file goes after
 * the seams instead — the send that lands either side of IST midnight, the date
 * that is not a date, and the pagination boundaries.
 */

test.describe('admin ops — daily usage report', () => {
  let admin: Customer;
  let customer: Customer;

  /**
   * 19:00 UTC on the 10th is 00:30 on the 11th in IST. A report bucketed on UTC
   * days would file this under the 10th, which is the whole reason the endpoint
   * takes an IST calendar date rather than a timestamp range.
   */
  const JUST_AFTER_IST_MIDNIGHT = new Date('2026-03-10T19:00:00.000Z');

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

  test('a send just after IST midnight belongs to the new day, not the old one', async ({
    request,
  }) => {
    await seedDeliveredMessage(customer.id, {
      costAmount: 0.25,
      updatedAt: JUST_AFTER_IST_MIDNIGHT,
    });

    const eleventh = await request.get(
      '/admin/dashboard/daily-usage?date=2026-03-11',
      { headers: auth(admin.accessToken) },
    );
    expect(eleventh.status(), await eleventh.text()).toBe(200);
    const onTheEleventh =
      await payload<{ user: { id: string }; totalMessages: number }[]>(
        eleventh,
      );
    expect(onTheEleventh.map((r) => r.user.id)).toEqual([customer.id]);
    expect(onTheEleventh[0].totalMessages).toBe(1);

    const tenth = await request.get(
      '/admin/dashboard/daily-usage?date=2026-03-10',
      { headers: auth(admin.accessToken) },
    );
    const onTheTenth = await payload<{ user: { id: string } }[]>(tenth);
    expect(onTheTenth).toEqual([]);
  });

  test('a failed send is reported but never charged for', async ({
    request,
  }) => {
    // Spend is summed only over delivered rows. A failed send that still showed
    // up in `totalSpent` would have support refunding money the customer was
    // never billed.
    await seedDeliveredMessage(customer.id, {
      costAmount: 0.25,
      updatedAt: JUST_AFTER_IST_MIDNIGHT,
    });
    await seedDeliveredMessage(customer.id, {
      costAmount: 0.25,
      status: 'failed',
      updatedAt: JUST_AFTER_IST_MIDNIGHT,
    });

    const res = await request.get(
      '/admin/dashboard/daily-usage?date=2026-03-11',
      { headers: auth(admin.accessToken) },
    );
    const [row] = await payload<
      {
        totalMessages: number;
        deliveredCount: number;
        failedCount: number;
        totalSpent: number;
      }[]
    >(res);

    expect(row.totalMessages).toBe(2);
    expect(row.deliveredCount).toBe(1);
    expect(row.failedCount).toBe(1);
    expect(row.totalSpent).toBe(0.25);
  });

  test('a date that is not a date is refused rather than reported on', async ({
    request,
  }) => {
    // `@Matches(/^\d{4}-\d{2}-\d{2}$/)` is the only guard, so these are the
    // shapes it is supposed to catch. `?date=` is included because a cleared
    // date picker sends exactly that: @IsOptional only skips null/undefined, so
    // an empty string is validated and rejected — unlike `?page=`, which the
    // pagination DTO goes out of its way to treat as absent.
    for (const value of [
      '2026-3-11',
      '11-03-2026',
      'yesterday',
      '2026-03-11T00:00:00Z',
      '',
    ]) {
      const res = await request.get(
        `/admin/dashboard/daily-usage?date=${encodeURIComponent(value)}`,
        { headers: auth(admin.accessToken) },
      );
      expect(res.status(), `date=${value} was accepted`).toBe(400);
      expect(await errorCode(res)).toBe('VALIDATION_ERROR');
    }
  });

  test('a well-formed but impossible date does not reach the database as a broken timestamp', async ({
    request,
  }) => {
    // `date` is range-checked, not only shape-checked: the DTO pairs
    // `@Matches(/^\d{4}-\d{2}-\d{2}$/)` with `@IsDateString()`, whose ISO 8601
    // check holds the month to 01-12 and the day to 01-31, so a month of 13 or
    // a 45th day is refused at the pipe with a 400. It used to pass the shape
    // check on its own, reach parseISTDate as an Invalid Date, and go into the
    // query as a bind parameter that node-postgres serialised to
    // "0NaN-NaN-NaNTNaN:NaN:NaN.NaN+NaN:NaN"; Postgres rejected the timestamp
    // and the TypeORM QueryFailedError — not an HttpException — left
    // AllExceptionsFilter answering 500.
    //
    // Anything the pipe now lets through parses to a real instant, which is
    // what this asserts. The February 30th case below is a different question —
    // it parses fine and rolls forward — and is deliberately left alone here.
    for (const value of ['2026-13-45', '0000-00-00', '9999-99-99']) {
      const res = await request.get(
        `/admin/dashboard/daily-usage?date=${value}`,
        { headers: auth(admin.accessToken) },
      );
      expect(
        res.status(),
        `date=${value} produced a server error: ${await res.text()}`,
      ).toBeLessThan(500);
    }
  });

  test('an impossible day silently rolls over into the next month', async ({
    request,
  }) => {
    // February 30th does not exist, but `new Date('2026-02-30T00:00:00Z')`
    // rolls forward to March 2nd, so the report answers for a different day
    // than the one that was asked for — with no indication that it did.
    // Asserted as it behaves today; see the note in the return payload.
    //
    // The range check added to `date` deliberately stops short of this:
    // `@IsDateString()` without `{ strict: true }` rejects a 13th month and a
    // 45th day (which parse to nothing at all) while still accepting a day the
    // month happens not to have (which parses to a real, if wrong, instant).
    await seedDeliveredMessage(customer.id, {
      costAmount: 0.25,
      updatedAt: new Date('2026-03-02T06:00:00.000Z'),
    });

    const res = await request.get(
      '/admin/dashboard/daily-usage?date=2026-02-30',
      { headers: auth(admin.accessToken) },
    );
    expect(res.status(), await res.text()).toBe(200);

    const rows = await payload<{ user: { id: string } }[]>(res);
    expect(
      rows.map((r) => r.user.id),
      'the 30th of February reported on a day other than the one asked for',
    ).toEqual([customer.id]);
  });

  test('pagination boundaries are refused rather than clamped', async ({
    request,
  }) => {
    for (const query of [
      'page=0',
      'page=-1',
      'page=abc',
      'page=1.5',
      'page=1&page=2', // an array where a scalar is expected
      'limit=0',
      'limit=101', // one past MAX_PAGE_SIZE
      'limit=-20',
      'withCount=maybe',
    ]) {
      const res = await request.get(`/admin/dashboard/daily-usage?${query}`, {
        headers: auth(admin.accessToken),
      });
      expect(res.status(), `?${query} was accepted`).toBe(400);
    }

    // Blank page and limit are the shape of a truncated shared link and are
    // deliberately treated as absent.
    const blank = await request.get(
      '/admin/dashboard/daily-usage?page=&limit=',
      { headers: auth(admin.accessToken) },
    );
    expect(blank.status(), await blank.text()).toBe(200);
    expect((await pagination(blank)).limit).toBe(20);

    // The cap itself is allowed.
    const atCap = await request.get('/admin/dashboard/daily-usage?limit=100', {
      headers: auth(admin.accessToken),
    });
    expect(atCap.status(), await atCap.text()).toBe(200);
  });

  test('paging far past the end is an empty page, not an error', async ({
    request,
  }) => {
    // This report builds its own OFFSET rather than going through
    // paginateQueryBuilder, so the MAX_OFFSET ceiling that guards the template
    // list does not apply here. Pinned so the difference is deliberate.
    await seedDeliveredMessage(customer.id, {
      costAmount: 0.25,
      updatedAt: JUST_AFTER_IST_MIDNIGHT,
    });

    const res = await request.get(
      '/admin/dashboard/daily-usage?date=2026-03-11&page=1000000&limit=20',
      { headers: auth(admin.accessToken) },
    );
    expect(res.status(), await res.text()).toBe(200);
    expect(await payload<unknown[]>(res)).toEqual([]);

    const meta = await pagination(res);
    expect(meta.totalItems).toBe(1);
    expect(meta.hasNextPage).toBe(false);
  });

  test('search narrows the report to the accounts that match, with their enrichment attached', async ({
    request,
  }) => {
    // The search parameter and the per-row tags/derivedTags/metrics block —
    // the controller's whole second half — had no assertion anywhere.
    const other = await createCustomer(request);
    await onboardCustomer(other.id);
    await seedDeliveredMessage(customer.id, {
      costAmount: 0.25,
      updatedAt: JUST_AFTER_IST_MIDNIGHT,
    });
    await seedDeliveredMessage(other.id, {
      costAmount: 0.25,
      updatedAt: JUST_AFTER_IST_MIDNIGHT,
    });

    // Both accounts sent on the day; the search keeps only the matching one.
    const searched = await request.get(
      `/admin/dashboard/daily-usage?date=2026-03-11&search=${customer.email}`,
      { headers: auth(admin.accessToken) },
    );
    expect(searched.status(), await searched.text()).toBe(200);
    const rows = await payload<
      {
        user: { id: string };
        totalMessages: number;
        tags: unknown[];
        derivedTags: { kind: string; key: string }[];
        metrics: { balance: number; lifetimeMessages: number } | null;
      }[]
    >(searched);
    expect(rows.map((r) => r.user.id)).toEqual([customer.id]);
    expect((await pagination(searched)).totalItems).toBe(1);

    // The row is enriched, not bare usage numbers: derived tags computed from
    // the account's facts, metrics agreeing with the wallet. (lifetime, not
    // the 30-day window — the report's fixture day is a fixed past date.)
    expect(rows[0].tags).toEqual([]);
    expect(rows[0].derivedTags.map((t) => t.key)).toContain('topup:0');
    expect(rows[0].metrics).not.toBeNull();
    expect(rows[0].metrics?.balance).toBe(10);
    expect(rows[0].metrics?.lifetimeMessages).toBe(1);

    // A term matching nobody is an empty report, not everyone's.
    const nobody = await request.get(
      '/admin/dashboard/daily-usage?date=2026-03-11&search=no-such-account-xyz',
      { headers: auth(admin.accessToken) },
    );
    expect(await payload<unknown[]>(nobody)).toEqual([]);
    expect((await pagination(nobody)).totalItems).toBe(0);
  });

  test('opting out of the count reports an unknown total rather than zero', async ({
    request,
  }) => {
    // A total of 0 would render as "no results" over a page that plainly has
    // results. The sentinel is -1 for exactly that reason.
    await seedDeliveredMessage(customer.id, {
      costAmount: 0.25,
      updatedAt: JUST_AFTER_IST_MIDNIGHT,
    });

    for (const spelling of ['false', '0', 'no', 'n']) {
      const res = await request.get(
        `/admin/dashboard/daily-usage?date=2026-03-11&withCount=${spelling}`,
        { headers: auth(admin.accessToken) },
      );
      expect(res.status(), await res.text()).toBe(200);

      const meta = await pagination(res);
      expect(meta.totalItems, `withCount=${spelling}`).toBe(-1);
      expect(meta.totalPages).toBe(-1);
      expect((await payload<unknown[]>(res)).length).toBe(1);
    }
  });
});
