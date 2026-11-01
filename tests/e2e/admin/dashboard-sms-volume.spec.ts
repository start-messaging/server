import { test, expect } from '@playwright/test';
import { resetDb, closeDb, sql } from '../helpers/db.js';
import {
  createAdmin,
  createCustomer,
  onboardCustomer,
  auth,
  payload,
  Customer,
} from '../helpers/actors.js';
import { removeFixtures } from './ops-helpers.js';
import {
  bandWidth,
  describeDailyVolume,
} from '../../../src/messages/daily-volume-stats.js';

/**
 * Daily SMS volume on the admin dashboard: how much is handled per day, and the
 * mean, median and mode of it.
 */

const day = (date: string, total: number) => ({ date, total });

test.describe('daily volume statistics', () => {
  test('mean, median, busiest and quietest day', () => {
    const s = describeDailyVolume([
      day('d1', 900),
      day('d2', 1100),
      day('d3', 1300),
      day('d4', 1500),
    ])!;
    expect(s.completeDays).toBe(4);
    expect(s.total).toBe(4800);
    expect(s.mean).toBe(1200);
    // Even count: the middle two averaged.
    expect(s.median).toBe(1200);
    expect(s.min).toEqual(day('d1', 900));
    expect(s.max).toEqual(day('d4', 1500));

    expect(describeDailyVolume([day('a', 5), day('b', 1), day('c', 9)])!.median).toBe(5);
  });

  test('the mode is the most common volume band, because exact counts almost never repeat', () => {
    const s = describeDailyVolume(
      [1000, 1050, 1010, 1020, 1100, 1150, 1900].map((t, i) => day(`d${i}`, t)),
    )!;
    // Spread 900 → bands 100 wide; four days sit in 1,000–1,099.
    expect(s.mode).toEqual({ from: 1000, to: 1099, days: 4, width: 100 });
    // Nothing repeats exactly, so there is no exact mode to report.
    expect(s.exactMode).toBeNull();
  });

  test('an exact mode is reported when a count really does repeat', () => {
    const s = describeDailyVolume(
      [1100, 1200, 1200, 1200, 1300, 1100].map((t, i) => day(`d${i}`, t)),
    )!;
    expect(s.exactMode).toEqual({ value: 1200, days: 3 });
  });

  test('no exact mode is named when several counts tie for most repeated', () => {
    // 1,100 and 1,200 each occur twice: naming either would be arbitrary.
    const s = describeDailyVolume(
      [1100, 1100, 1200, 1200, 1300].map((t, i) => day(`d${i}`, t)),
    )!;
    expect(s.exactMode).toBeNull();
  });

  test('a tie between bands goes to the one nearest the median', () => {
    // Spread 205 gives bands 25 wide. Two bands tie at three days each —
    // 100–124 and 300–324 — with one day in between. The median is 200, which is
    // nearer 100–124 (centre 112) than 300–324 (centre 312), so that one wins.
    const s = describeDailyVolume(
      [100, 101, 105, 200, 300, 301, 305].map((t, i) => day(`d${i}`, t)),
    )!;
    expect(s.median).toBe(200);
    expect(s.mode).toEqual({ from: 100, to: 124, days: 3, width: 25 });
  });

  test('band widths are round whole numbers giving about ten bands', () => {
    const cases: [number, number][] = [
      [0, 1],
      [5, 1],
      [10, 1],
      [20, 2],
      [50, 5],
      [99, 10],
      [105, 20],
      [1050, 200],
      [2500, 250],
      [10000, 1000],
    ];
    for (const [spread, width] of cases) {
      expect(bandWidth(spread), `spread ${spread}`).toBe(width);
    }
  });

  test('one day, identical days and no days are all handled', () => {
    expect(describeDailyVolume([])).toBeNull();
    const one = describeDailyVolume([day('only', 777)])!;
    expect([one.mean, one.median, one.min.total, one.max.total]).toEqual([777, 777, 777, 777]);
    const flat = describeDailyVolume([day('a', 500), day('b', 500), day('c', 500)])!;
    expect(flat.mode).toEqual({ from: 500, to: 500, days: 3, width: 1 });
    expect(flat.exactMode).toEqual({ value: 500, days: 3 });
  });
});

interface Day {
  date: string;
  total: number;
  delivered: number;
  failed: number;
  other: number;
  partial: boolean;
}
interface VolumeBody {
  days: Day[];
  stats: {
    completeDays: number;
    total: number;
    mean: number;
    median: number;
    mode: { from: number; to: number; days: number; width: number };
    exactMode: { value: number; days: number } | null;
    min: { date: string; total: number };
    max: { date: string; total: number };
  } | null;
  today: Day;
  previous: { completeDays: number; mean: number } | null;
  changePercent: number | null;
}

const istDate = (daysAgo: number, now = Date.now()) =>
  new Date(now + 5.5 * 3600_000 - daysAgo * 86_400_000).toISOString().slice(0, 10);

test.describe('admin dashboard — SMS volume', () => {
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

  /** `n` messages of one status, `daysAgo` IST days back, at noon IST. */
  async function seed(daysAgo: number, status: string, n: number) {
    if (n === 0) return;
    await sql(
      `INSERT INTO "messages"
         ("userId","phoneNumber","content","provider","status","costAmount","createdAt","updatedAt")
       SELECT $1, '+919000000000', 'OTP 123456', 'console', $2, 0.25, t, t
         FROM (SELECT (date_trunc('day', now() AT TIME ZONE 'Asia/Kolkata')
                       - make_interval(days => $3::int) + interval '12 hours')
                       AT TIME ZONE 'Asia/Kolkata' AS t) base,
              generate_series(1, $4::int)`,
      [customer.id, status, daysAgo, n],
    );
  }

  const volume = async (
    request: import('@playwright/test').APIRequestContext,
    query = '',
  ) => {
    const res = await request.get(`/admin/dashboard/sms-volume${query}`, {
      headers: auth(admin.accessToken),
    });
    expect(res.status(), await res.text()).toBe(200);
    return payload<VolumeBody>(res);
  };

  test('every day is present, oldest first, with the delivered / failed / other split', async ({
    request,
  }) => {
    await seed(3, 'delivered', 90);
    await seed(3, 'failed', 7);
    await seed(3, 'sent', 3); // in flight: neither delivered nor failed
    const body = await volume(request, '?days=7');

    expect(body.days).toHaveLength(7);
    const dates = body.days.map((d) => d.date);
    expect(dates).toEqual([...dates].sort());
    expect(dates[0]).toBe(istDate(6));
    expect(dates[6]).toBe(istDate(0));

    const busy = body.days.find((d) => d.date === istDate(3))!;
    expect(busy).toMatchObject({ total: 100, delivered: 90, failed: 7, other: 3 });
    // The rest are zero-filled, not missing.
    expect(body.days.filter((d) => d.total === 0)).toHaveLength(6);
  });

  test('statistics are over complete days; today is shown but left out', async ({ request }) => {
    // Three finished days of 100, 200, 300 and an unfinished today.
    await seed(3, 'delivered', 100);
    await seed(2, 'delivered', 200);
    await seed(1, 'delivered', 300);
    await seed(0, 'delivered', 40);
    const body = await volume(request, '?days=7');

    expect(body.days[6].partial).toBe(true);
    expect(body.days.slice(0, 6).every((d) => !d.partial)).toBe(true);
    expect(body.today).toMatchObject({ date: istDate(0), total: 40, partial: true });

    // Six complete days (three of them empty): 600 / 6 = 100, today's 40 excluded.
    expect(body.stats!.completeDays).toBe(6);
    expect(body.stats!.total).toBe(600);
    expect(body.stats!.mean).toBe(100);
    expect(body.stats!.median).toBe(50); // 0,0,0,100,200,300
    expect(body.stats!.max).toEqual({ date: istDate(1), total: 300 });
    expect(body.stats!.min.total).toBe(0);
    // Three zero days make 0 the repeated value, and 0–49 the fullest band.
    expect(body.stats!.exactMode).toEqual({ value: 0, days: 3 });
    expect(body.stats!.mode).toMatchObject({ from: 0, to: 49, days: 3 });
  });

  test('a message just before IST midnight and one just after land on different days', async ({
    request,
  }) => {
    const todayIst = istDate(0);
    const yesterdayIst = istDate(1);
    const insert = (at: string) =>
      sql(
        `INSERT INTO "messages" ("userId","phoneNumber","content","provider","status","costAmount","createdAt","updatedAt")
         VALUES ($1,'+919000000000','OTP 1','console','delivered',0.25,$2::timestamptz,$2::timestamptz)`,
        [customer.id, at],
      );
    await insert(`${yesterdayIst}T23:59:30+05:30`);
    await insert(`${todayIst}T00:00:30+05:30`);
    const body = await volume(request, '?days=3');
    expect(body.days.find((d) => d.date === yesterdayIst)!.total).toBe(1);
    expect(body.days.find((d) => d.date === todayIst)!.total).toBe(1);
  });

  test('the change is against the block of complete days before, and is null with nothing to compare', async ({
    request,
  }) => {
    // days=7: this block is 1–6 days ago; the previous block is 7–12 days ago.
    await seed(2, 'delivered', 300);
    await seed(4, 'delivered', 300); // this block: 600 over 6 days = mean 100
    await seed(8, 'delivered', 120);
    await seed(10, 'delivered', 60); // previous block: 180 over 6 days = mean 30
    const body = await volume(request, '?days=7');
    expect(body.stats!.mean).toBe(100);
    expect(body.previous).toEqual({ completeDays: 6, mean: 30 });
    expect(body.changePercent).toBe(233.3);

    await resetDb();
    await removeFixtures();
    admin = await createAdmin(request);
    customer = await createCustomer(request);
    await onboardCustomer(customer.id);
    await seed(2, 'delivered', 50);
    const fresh = await volume(request, '?days=7');
    expect(fresh.previous!.mean).toBe(0);
    expect(fresh.changePercent).toBeNull();
  });

  test('one day has no complete days to describe, so no statistics, but still today', async ({
    request,
  }) => {
    await seed(0, 'delivered', 12);
    const body = await volume(request, '?days=1');
    expect(body.days).toHaveLength(1);
    expect(body.stats).toBeNull();
    expect(body.previous).toBeNull();
    expect(body.changePercent).toBeNull();
    expect(body.today.total).toBe(12);
  });

  test('with no messages at all the statistics are zeros, not errors', async ({ request }) => {
    const body = await volume(request, '?days=30');
    expect(body.days).toHaveLength(30);
    expect(body.stats).toMatchObject({ completeDays: 29, total: 0, mean: 0, median: 0 });
    expect(body.changePercent).toBeNull();
  });

  test('only an admin may read it, and the window is bounded', async ({ request }) => {
    const anon = await request.get('/admin/dashboard/sms-volume');
    expect(anon.status()).toBe(401);
    const asCustomer = await request.get('/admin/dashboard/sms-volume', {
      headers: auth(customer.accessToken),
    });
    expect(asCustomer.status()).toBe(403);

    for (const q of ['?days=0', '?days=-1', '?days=181', '?days=abc', '?days=1.5', '?days=']) {
      const res = await request.get(`/admin/dashboard/sms-volume${q}`, {
        headers: auth(admin.accessToken),
      });
      expect(res.status(), q).toBe(400);
    }
    for (const q of ['?days=1', '?days=180', '']) {
      const res = await request.get(`/admin/dashboard/sms-volume${q}`, {
        headers: auth(admin.accessToken),
      });
      expect(res.status(), q).toBe(200);
    }
  });
});
