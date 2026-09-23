import { test, expect, APIRequestContext } from '@playwright/test';
import { resetDb, closeDb, sql } from '../helpers/db.js';
import {
  createAdmin,
  createCustomer,
  createPartner,
  seedDeliveredMessage,
  unique,
  auth,
  payload,
  Customer,
} from '../helpers/actors.js';
import { errorCode, errorMessage, pagination } from './ops-helpers.js';

/**
 * The admin growth screen: how many signed up, where they stalled, who called
 * them, and what we emailed them.
 *
 * The four things this file exists to hold down, each of which was a real trap
 * in the live data before the endpoint was written:
 *
 *   1. Everything is scoped to role='customer'. sm_db has four admin rows, and
 *      a screen about signups that counts its own staff is wrong by four before
 *      it starts.
 *   2. Call coverage is measured on adminLastCalledAt, never adminCallNotes.
 *      Forty called accounts have no note; counting notes reports 38.8% where
 *      the truth is 49.0%.
 *   3. A rate over an empty denominator is null, not 0. "0% called" and "nobody
 *      signed up" are different facts and an operator acts on them differently.
 *   4. The reminder table is empty, and the payload has to say so in words.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

type Kyc = 'not_submitted' | 'pending' | 'approved' | 'rejected';

interface RateEnvelope {
  value: number | null;
  numerator: number;
  denominator: number;
  sufficient: boolean;
  reason: string | null;
}

interface FunnelStage {
  key: string;
  label: string;
  reached: number;
  matched: number;
  lostFromPrevious: number;
  conversionFromPrevious: RateEnvelope;
  conversionFromSignup: RateEnvelope;
}

interface GrowthBody {
  window: {
    from: string;
    toExclusive: string;
    granularity: 'day' | 'week';
    buckets: number;
    timezone: string;
    defaulted: boolean;
  };
  signups: { total: number; series: { bucket: string; count: number }[] };
  funnel: {
    stages: FunnelStage[];
    biggestDropOff: { from: string; to: string; lost: number } | null;
    monotone: boolean;
  };
  calling: {
    called: number;
    uncalled: number;
    withNotes: number;
    notedWithoutCall: number;
    coverage: RateEnvelope;
    noteRate: RateEnvelope;
    lastCalledAt: string | null;
    staleDays: number | null;
    source: string;
    sourceNote: string;
  };
  email: {
    totalSent: number;
    totalRows: number;
    pending: number;
    failed: number;
    byStage: { key: string; count: number }[];
    byBlockedStep: { key: string; count: number }[];
    byStatus: { key: string; count: number }[];
    matrix: {
      stage: string;
      blockedStep: string;
      status: string;
      count: number;
    }[];
    recent: {
      userId: string;
      email: string;
      stage: string;
      blockedStep: string | null;
      status: string;
      sentAt: string | null;
      copy: { subject: string; ask: string } | null;
    }[];
    catalogue: { stage: string; blockedStep: string; subject: string }[];
    none: boolean;
    neverAny: boolean;
    reason: string | null;
    scope: string;
  };
  asOf: {
    generatedAt: string;
    customersAllTime: number;
    earliestSignupAt: string | null;
    latestSignupAt: string | null;
    windowHasData: boolean;
  };
}

interface NoteRow {
  userId: string;
  email: string;
  name: string | null;
  calledAt: string | null;
  note: string | null;
  hasNote: boolean;
  kycStatus: string;
  mobileVerified: boolean;
  signedUpAt: string | null;
}

/**
 * Inserts one account in an exact state.
 *
 * Direct SQL rather than the registration API for two reasons: `createdAt` is
 * the axis every one of these assertions turns on and no endpoint lets a caller
 * set it, and `/auth/register` is throttled to 5/min per IP, which a cohort of
 * eleven would trip halfway through.
 */
async function seedAccount(opts: {
  daysAgo?: number;
  createdAt?: Date;
  role?: 'customer' | 'admin';
  mobileVerified?: boolean;
  kycStatus?: Kyc;
  kycSubmitted?: boolean;
  calledAt?: Date | null;
  note?: string | null;
}): Promise<string> {
  const createdAt =
    opts.createdAt ?? new Date(Date.now() - (opts.daysAgo ?? 0) * DAY_MS);
  const kycStatus: Kyc = opts.kycStatus ?? 'not_submitted';

  const [row] = await sql<{ id: string }>(
    `INSERT INTO "users"
       ("email", "firstName", "lastName", "role", "createdAt",
        "mobileVerified", "kycStatus", "kycSubmittedAt",
        "adminLastCalledAt", "adminCallNotes")
     VALUES ($1, 'Growth', 'Fixture', $2::"users_role_enum", $3,
             $4, $5::"users_kycStatus_enum", $6, $7, $8)
     RETURNING "id"`,
    [
      `${unique('growth')}@example.com`,
      opts.role ?? 'customer',
      createdAt,
      opts.mobileVerified ?? false,
      kycStatus,
      opts.kycSubmitted ? new Date(createdAt.getTime() + 60_000) : null,
      opts.calledAt ?? null,
      opts.note ?? null,
    ],
  );
  return row.id;
}

async function seedReminder(opts: {
  userId: string;
  stage: 'day_2' | 'day_7';
  blockedStep: string | null;
  status: 'pending' | 'sent' | 'failed';
  at: Date;
  attempts?: number;
  lastError?: string | null;
}): Promise<void> {
  await sql(
    `INSERT INTO "onboarding_reminders"
       ("userId", "stage", "status", "blockedStep", "attempts",
        "sentAt", "lastError", "createdAt", "updatedAt")
     VALUES ($1, $2::"onboarding_reminders_stage_enum",
             $3::"onboarding_reminders_status_enum", $4, $5, $6, $7, $8, $8)`,
    [
      opts.userId,
      opts.stage,
      opts.status,
      opts.blockedStep,
      opts.attempts ?? 1,
      opts.status === 'sent' ? opts.at : null,
      opts.lastError ?? null,
      opts.at,
    ],
  );
}

/**
 * The window every cohort assertion below uses: 40 to 10 days back.
 *
 * Deliberately in the past and deliberately closed before today, so the admin
 * and customer that `beforeEach` registers through the API — both created at
 * `now()` — sit outside it. Any of their state leaking into a cohort figure is
 * then a failure rather than a coincidence.
 */
const WINDOW = { from: 40, to: 10 };

function windowQuery(extra = ''): string {
  const from = new Date(Date.now() - WINDOW.from * DAY_MS).toISOString();
  const to = new Date(Date.now() - WINDOW.to * DAY_MS).toISOString();
  return `/admin/growth?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}${extra}`;
}

async function growth(
  request: APIRequestContext,
  token: string,
  url: string,
): Promise<GrowthBody> {
  const res = await request.get(url, { headers: auth(token) });
  expect(res.status(), await res.text()).toBe(200);
  return payload<GrowthBody>(res);
}

/** Ten customers inside WINDOW, laddered so every funnel figure is known. */
async function seedCohort(): Promise<{ senders: string[]; called: string[] }> {
  const at = 25;
  const senders: string[] = [];
  const called: string[] = [];

  // Two reach the end: approved, and have actually sent something.
  for (let i = 0; i < 2; i += 1) {
    const id = await seedAccount({
      daysAgo: at,
      mobileVerified: true,
      kycSubmitted: true,
      kycStatus: 'approved',
      calledAt: new Date(Date.now() - 12 * DAY_MS),
      note: `spoke to sender ${i}`,
    });
    await seedDeliveredMessage(id);
    senders.push(id);
    called.push(id);
  }

  // Two are approved but have never sent.
  for (let i = 0; i < 2; i += 1) {
    called.push(
      await seedAccount({
        daysAgo: at,
        mobileVerified: true,
        kycSubmitted: true,
        kycStatus: 'approved',
        calledAt: new Date(Date.now() - 13 * DAY_MS),
        note: `spoke to approved ${i}`,
      }),
    );
  }

  // One submitted and is still waiting on review.
  called.push(
    await seedAccount({
      daysAgo: at,
      mobileVerified: true,
      kycSubmitted: true,
      kycStatus: 'pending',
      // Called, never written up. This is the 40-account gap in miniature, and
      // the reason coverage is measured on the timestamp and not on the note.
      calledAt: new Date(Date.now() - 14 * DAY_MS),
      note: null,
    }),
  );

  // Two verified their mobile and stopped there.
  called.push(
    await seedAccount({
      daysAgo: at,
      mobileVerified: true,
      calledAt: new Date(Date.now() - 15 * DAY_MS),
      // Whitespace is not a note. If this counted, withNotes would read 5.
      note: '   ',
    }),
  );
  await seedAccount({ daysAgo: at, mobileVerified: true });

  // Three never got past mobile verification and were never called.
  for (let i = 0; i < 3; i += 1) {
    await seedAccount({ daysAgo: at });
  }

  return { senders, called };
}

test.describe('admin growth — signups, funnel, calling and reminder email', () => {
  let admin: Customer;
  let customer: Customer;

  test.beforeEach(async ({ request }) => {
    await resetDb();
    admin = await createAdmin(request);
    customer = await createCustomer(request);
  });

  test.afterAll(async () => {
    await closeDb();
  });

  const ROUTES: [string, string][] = [
    ['GET', '/admin/growth'],
    ['GET', '/admin/growth/notes'],
  ];

  test('neither endpoint answers without a session, or to a customer', async ({
    request,
  }) => {
    // The two are not interchangeable. 401 says "no session"; 403 says "this
    // session is real but is not an admin". A customer answered 401 sends the
    // panel into a refresh loop; an anonymous caller answered 403 confirms to a
    // prober that the route exists.
    const partner = await createPartner(request);

    for (const [method, path] of ROUTES) {
      const anonymous = await request.fetch(path, { method });
      expect(anonymous.status(), `${method} ${path} as anonymous`).toBe(401);
      expect(await errorCode(anonymous)).toBe('UNAUTHORIZED');

      const asCustomer = await request.fetch(path, {
        method,
        headers: auth(customer.accessToken),
      });
      expect(asCustomer.status(), `${method} ${path} as a customer`).toBe(403);
      expect(await errorCode(asCustomer)).toBe('FORBIDDEN');

      // A partner token is signed with a different secret, so it does not even
      // decode here — 401, not 403.
      const asPartner = await request.fetch(path, {
        method,
        headers: auth(partner.accessToken),
      });
      expect(asPartner.status(), `${method} ${path} as a partner`).toBe(401);
    }
  });

  test('a window with no signups reports null rates, never zero', async ({
    request,
  }) => {
    // The defect this whole endpoint's rate envelope exists to prevent. sm_db is
    // a restored dump with nothing in the last 30 days, so the *default* view of
    // this screen is precisely this case: an operator who reads "0% called"
    // concludes the calling team did nothing, when in fact nobody signed up.
    await seedCohort();

    const body = await growth(
      request,
      admin.accessToken,
      '/admin/growth?from=2019-01-01&to=2019-01-31',
    );

    expect(body.signups.total).toBe(0);
    expect(body.asOf.windowHasData).toBe(false);

    const coverage = body.calling.coverage;
    expect(coverage.value).toBeNull();
    expect(coverage.value).not.toBe(0);
    expect(coverage.sufficient).toBe(false);
    expect(coverage.numerator).toBe(0);
    expect(coverage.denominator).toBe(0);
    expect(coverage.reason).toContain('nobody to call');

    expect(body.calling.noteRate.value).toBeNull();
    expect(body.calling.noteRate.sufficient).toBe(false);
    expect(body.calling.lastCalledAt).toBeNull();
    expect(body.calling.staleDays).toBeNull();

    // Every conversion in the ladder, not just the first one — a COALESCE
    // introduced anywhere between the SQL and the payload would show up here.
    for (const stage of body.funnel.stages) {
      expect(stage.reached, stage.key).toBe(0);
      expect(stage.conversionFromPrevious.value, stage.key).toBeNull();
      expect(stage.conversionFromPrevious.sufficient, stage.key).toBe(false);
      expect(stage.conversionFromPrevious.reason, stage.key).toBeTruthy();
      expect(stage.conversionFromSignup.value, stage.key).toBeNull();
    }

    // The window is empty; the database is not. An operator needs to be told
    // where the data actually is, or the screen is a dead end.
    expect(body.asOf.customersAllTime).toBeGreaterThan(0);
    expect(body.asOf.latestSignupAt).not.toBeNull();
    expect(body.asOf.earliestSignupAt).not.toBeNull();
  });

  test('a window covering the cohort reports the measured funnel', async ({
    request,
  }) => {
    await seedCohort();

    const body = await growth(request, admin.accessToken, windowQuery());
    const by = Object.fromEntries(
      body.funnel.stages.map((s) => [s.key, s]),
    ) as Record<string, FunnelStage>;

    expect(body.signups.total).toBe(10);
    expect(body.asOf.windowHasData).toBe(true);

    expect(body.funnel.stages.map((s) => s.key)).toEqual([
      'signed_up',
      'mobile_verified',
      'kyc_submitted',
      'kyc_approved',
      'first_message',
    ]);
    expect(body.funnel.stages.map((s) => s.reached)).toEqual([10, 7, 5, 4, 2]);
    expect(body.funnel.stages.map((s) => s.lostFromPrevious)).toEqual([
      0, 3, 2, 1, 2,
    ]);

    // Rates divide in Postgres numeric and arrive rounded to one place;
    // 5/7 is the one that would expose a float or an integer division.
    expect(by.mobile_verified.conversionFromPrevious.value).toBe(70);
    expect(by.kyc_submitted.conversionFromPrevious.value).toBe(71.4);
    expect(by.kyc_approved.conversionFromPrevious.value).toBe(80);
    expect(by.first_message.conversionFromPrevious.value).toBe(50);
    expect(by.first_message.conversionFromSignup.value).toBe(20);
    for (const stage of body.funnel.stages) {
      expect(stage.conversionFromPrevious.sufficient, stage.key).toBe(true);
      expect(stage.conversionFromPrevious.reason, stage.key).toBeNull();
    }

    // The single biggest leak is the one thing an operator acts on.
    expect(body.funnel.biggestDropOff).toEqual({
      from: 'signed_up',
      to: 'mobile_verified',
      lost: 3,
    });
  });

  test('the funnel is monotone even when an account is out of order', async ({
    request,
  }) => {
    await seedCohort();

    // sm_db has exactly this: an approved account whose mobile was never marked
    // verified. Counted independently the ladder still descends today, but only
    // by luck — one more such row and the "KYC approved" bar is taller than
    // "mobile verified". `reached` is a strict conjunction so it cannot happen,
    // and `matched` publishes the disagreement instead of hiding it.
    await seedAccount({
      daysAgo: 25,
      mobileVerified: false,
      kycSubmitted: true,
      kycStatus: 'approved',
    });

    const body = await growth(request, admin.accessToken, windowQuery());
    const stages = body.funnel.stages;

    expect(body.signups.total).toBe(11);
    expect(body.funnel.monotone).toBe(true);
    for (let i = 1; i < stages.length; i += 1) {
      expect(
        stages[i].reached,
        `${stages[i].key} must not exceed ${stages[i - 1].key}`,
      ).toBeLessThanOrEqual(stages[i - 1].reached);
    }

    // The anomaly clears the later gates on its own terms but never reached
    // them, so `matched` runs one ahead of `reached` from KYC submission down.
    expect(stages.map((s) => s.reached)).toEqual([11, 7, 5, 4, 2]);
    expect(stages.map((s) => s.matched)).toEqual([11, 7, 6, 5, 2]);
  });

  test('admins are counted nowhere, however they are dressed', async ({
    request,
  }) => {
    await seedCohort();

    // An admin sitting inside the window with a call and a note on it: the
    // single row that catches a missing role filter in the cohort, the calling
    // coverage, and the notes list all at once.
    const staff = await seedAccount({
      daysAgo: 25,
      role: 'admin',
      mobileVerified: true,
      kycSubmitted: true,
      kycStatus: 'approved',
      calledAt: new Date(Date.now() - 11 * DAY_MS),
      note: 'internal account, should never be on this screen',
    });

    const body = await growth(request, admin.accessToken, windowQuery());

    // Unchanged from the cohort-only run: the admin adds nothing anywhere.
    expect(body.signups.total).toBe(10);
    expect(body.funnel.stages.map((s) => s.reached)).toEqual([10, 7, 5, 4, 2]);
    expect(body.calling.called).toBe(6);
    expect(body.signups.series.reduce((n, b) => n + b.count, 0)).toBe(10);

    const notes = await request.get('/admin/growth/notes?limit=100', {
      headers: auth(admin.accessToken),
    });
    expect(notes.status(), await notes.text()).toBe(200);
    const rows = await payload<NoteRow[]>(notes);
    expect(rows.map((r) => r.userId)).not.toContain(staff);
    expect(rows.map((r) => r.userId)).not.toContain(admin.id);
  });

  test('call coverage is measured on the timestamp, not on the note', async ({
    request,
  }) => {
    // Six accounts carry a call timestamp; four carry a note worth the name.
    // Measuring coverage on notes would report 40% here and 38.8% on sm_db,
    // silently dropping every call the caller never wrote up.
    await seedCohort();

    const body = await growth(request, admin.accessToken, windowQuery());
    const calling = body.calling;

    expect(calling.called).toBe(6);
    expect(calling.uncalled).toBe(4);
    expect(calling.withNotes).toBe(4);
    expect(calling.notedWithoutCall).toBe(0);

    expect(calling.coverage.value).toBe(60);
    expect(calling.coverage.numerator).toBe(6);
    expect(calling.coverage.denominator).toBe(10);
    expect(calling.coverage.sufficient).toBe(true);

    // 4/6 rounds to 66.7, and it is a different number from coverage — which is
    // the point: "how many did we call" and "how many did we write up" are two
    // questions and this screen answers both.
    expect(calling.noteRate.value).toBe(66.7);
    expect(calling.noteRate.numerator).toBe(4);
    expect(calling.noteRate.denominator).toBe(6);

    expect(calling.lastCalledAt).not.toBeNull();
    expect(calling.staleDays).toBeGreaterThanOrEqual(11);

    // The timestamp is whatever an admin PATCHed on. The payload has to say so,
    // or the screen implies it observed a call it only ever took on trust.
    expect(calling.source).toBe('self_reported');
    expect(calling.sourceNote).toContain('PATCH');
  });

  test('the signup graph is zero-filled and bucketed on IST days', async ({
    request,
  }) => {
    // A missing bucket and a bucket of zero look identical in a line chart, and
    // the difference is exactly what this screen was asked for.
    await seedAccount({ createdAt: new Date('2026-05-10T06:00:00.000Z') });
    await seedAccount({ createdAt: new Date('2026-05-10T09:30:00.000Z') });
    // 19:00 UTC is 00:30 the next morning in IST. Bucketed on UTC this lands on
    // the 10th and the series is wrong by one on two separate days.
    await seedAccount({ createdAt: new Date('2026-05-10T19:00:00.000Z') });

    const body = await growth(
      request,
      admin.accessToken,
      '/admin/growth?from=2026-05-08&to=2026-05-12',
    );

    expect(body.signups.series).toEqual([
      { bucket: '2026-05-08', count: 0 },
      { bucket: '2026-05-09', count: 0 },
      { bucket: '2026-05-10', count: 2 },
      { bucket: '2026-05-11', count: 1 },
      { bucket: '2026-05-12', count: 0 },
    ]);
    expect(body.window.buckets).toBe(5);
    expect(body.window.granularity).toBe('day');
    expect(body.signups.total).toBe(3);

    // A bare YYYY-MM-DD `to` covers that whole IST day. Read as an instant it
    // would stop at midnight and drop the last day of every range an operator
    // ever types.
    expect(body.window.toExclusive).toBe('2026-05-12T18:30:00.000Z');
    expect(body.window.from).toBe('2026-05-07T18:30:00.000Z');
    expect(body.window.defaulted).toBe(false);
  });

  test('weekly granularity buckets the same accounts into fewer points', async ({
    request,
  }) => {
    await seedAccount({ createdAt: new Date('2026-05-10T06:00:00.000Z') });
    await seedAccount({ createdAt: new Date('2026-05-12T06:00:00.000Z') });
    await seedAccount({ createdAt: new Date('2026-05-20T06:00:00.000Z') });

    const body = await growth(
      request,
      admin.accessToken,
      '/admin/growth?from=2026-05-04&to=2026-05-24&granularity=week',
    );

    expect(body.window.granularity).toBe('week');
    expect(body.signups.total).toBe(3);
    expect(body.signups.series.reduce((n, b) => n + b.count, 0)).toBe(3);
    // Three weeks of Mondays, not twenty-one days.
    expect(body.signups.series).toHaveLength(3);
    expect(body.signups.series.map((b) => b.bucket)).toEqual([
      '2026-05-04',
      '2026-05-11',
      '2026-05-18',
    ]);
  });

  test('an unusable window is refused before any query runs', async ({
    request,
  }) => {
    const cases: [string, string][] = [
      // Backwards. Caught in the DTO so the message names the field.
      ['/admin/growth?from=2026-06-01&to=2026-05-01', 'to must not be earlier'],
      // Shaped like a date, is not one. Left unguarded this reached Postgres as
      // an invalid timestamp and surfaced as a 500.
      ['/admin/growth?from=2026-13-45', 'from must be a real'],
      ['/admin/growth?to=banana', 'to must be a real'],
      // Ninety years of daily buckets. Refused with the alternative named,
      // rather than materialised into a payload no chart can draw.
      ['/admin/growth?from=1970-01-01&to=2026-12-31', 'granularity=week'],
    ];

    for (const [url, fragment] of cases) {
      const res = await request.get(url, { headers: auth(admin.accessToken) });
      expect(res.status(), `${url} -> ${await res.text()}`).toBe(400);
      expect(await errorMessage(res)).toContain(fragment);
    }

    // A range wide enough to matter is fine once the buckets are weeks.
    const ok = await request.get(
      '/admin/growth?from=2024-01-01&to=2026-12-31&granularity=week',
      { headers: auth(admin.accessToken) },
    );
    expect(ok.status(), await ok.text()).toBe(200);
  });

  test('the reminder section says in words that nothing has been sent', async ({
    request,
  }) => {
    // onboarding_reminders is empty because the sweep only runs on production
    // (NODE_ENV=production with Mailgun configured), and this suite runs as
    // NODE_ENV=test. An empty bar chart reads as a broken render; a sentence
    // does not.
    await seedCohort();

    const body = await growth(request, admin.accessToken, windowQuery());

    expect(body.email.totalRows).toBe(0);
    expect(body.email.totalSent).toBe(0);
    expect(body.email.none).toBe(true);
    expect(body.email.neverAny).toBe(true);
    expect(body.email.reason).toContain('has ever been sent');
    expect(body.email.reason).toContain('runs only on production');
    expect(body.email.reason).not.toContain('ONBOARDING_REMINDERS_ENABLED');
    expect(body.email.byStage).toEqual([]);
    expect(body.email.recent).toEqual([]);

    // Zero sends does not mean the screen has nothing to say about what we send.
    // The catalogue is the six variants this system can put in an inbox, lifted
    // from EmailService rather than paraphrased here.
    expect(body.email.catalogue).toHaveLength(6);
    const day2Mobile = body.email.catalogue.find(
      (c) => c.stage === 'day_2' && c.blockedStep === 'mobile_verification',
    );
    expect(day2Mobile?.subject).toBe(
      'Verify your mobile number to finish signing up',
    );
  });

  test('reminder sends break down by stage, blocked step and status', async ({
    request,
  }) => {
    const { senders } = await seedCohort();
    const stalled = await seedAccount({ daysAgo: 25 });
    const at = new Date(Date.now() - 20 * DAY_MS);

    await seedReminder({
      userId: stalled,
      stage: 'day_2',
      blockedStep: 'mobile_verification',
      status: 'sent',
      at,
    });
    await seedReminder({
      userId: stalled,
      stage: 'day_7',
      blockedStep: 'mobile_verification',
      status: 'failed',
      at: new Date(Date.now() - 19 * DAY_MS),
      attempts: 3,
      lastError: 'mailbox unavailable',
    });
    await seedReminder({
      userId: senders[0],
      stage: 'day_2',
      blockedStep: 'kyc_submission',
      status: 'sent',
      at,
    });
    // Claimed but never resolved: the row is written before the send, so a
    // process killed mid-flight leaves this behind. Bucketing on sentAt alone
    // would drop it, and the failures are the half worth reading.
    await seedReminder({
      userId: senders[1],
      stage: 'day_2',
      blockedStep: 'kyc_resubmission',
      status: 'pending',
      at,
    });

    const body = await growth(request, admin.accessToken, windowQuery());
    const fold = (rows: { key: string; count: number }[]) =>
      Object.fromEntries(rows.map((r) => [r.key, r.count]));

    expect(body.email.none).toBe(false);
    expect(body.email.neverAny).toBe(false);
    expect(body.email.reason).toBeNull();

    expect(body.email.totalRows).toBe(4);
    expect(body.email.totalSent).toBe(2);
    expect(body.email.failed).toBe(1);
    expect(body.email.pending).toBe(1);

    expect(fold(body.email.byStage)).toEqual({ day_2: 3, day_7: 1 });
    expect(fold(body.email.byBlockedStep)).toEqual({
      mobile_verification: 2,
      kyc_submission: 1,
      kyc_resubmission: 1,
    });
    expect(fold(body.email.byStatus)).toEqual({
      sent: 2,
      failed: 1,
      pending: 1,
    });
    expect(body.email.matrix).toHaveLength(4);

    // "What we sent them" has to be readable, not just counted — so each recent
    // row carries the wording that row put in an inbox, resolved from
    // EmailService so the caption cannot drift from the mail.
    expect(body.email.recent).toHaveLength(4);
    const failed = body.email.recent.find((r) => r.status === 'failed');
    expect(failed?.stage).toBe('day_7');
    expect(failed?.copy?.subject).toBe(
      'Still want to go live? Your mobile number is still unverified',
    );
    const sentOne = body.email.recent.find(
      (r) => r.blockedStep === 'kyc_submission',
    );
    expect(sentOne?.copy?.ask).toContain('Submit your KYC');
    expect(sentOne?.sentAt).not.toBeNull();
  });

  test('an account called but never written up still appears in the notes list', async ({
    request,
  }) => {
    // The 40-account gap, in miniature. `hasNote` unset must show everyone the
    // calling team has touched; scoping the list to accounts with notes is how
    // forty real calls became invisible in the first place.
    await seedCohort();

    const all = await request.get('/admin/growth/notes?limit=50', {
      headers: auth(admin.accessToken),
    });
    expect(all.status(), await all.text()).toBe(200);
    const rows = await payload<NoteRow[]>(all);

    expect(rows).toHaveLength(6);
    expect(rows.filter((r) => r.hasNote)).toHaveLength(4);
    // Whitespace is not a note, in either direction.
    expect(rows.filter((r) => !r.hasNote)).toHaveLength(2);
    for (const row of rows.filter((r) => !r.hasNote)) {
      expect(row.note).toBeNull();
      expect(row.calledAt).not.toBeNull();
    }

    // Most recently called first, so the founder reads the newest work first.
    const called = rows.map((r) => r.calledAt ?? '');
    expect([...called].sort().reverse()).toEqual(called);

    // Each row carries enough to act on without a second request.
    expect(rows[0].email).toContain('@');
    expect(rows[0].signedUpAt).not.toBeNull();
    expect(typeof rows[0].mobileVerified).toBe('boolean');
    expect(rows[0].kycStatus).toBeTruthy();

    const withNote = await request.get('/admin/growth/notes?hasNote=true', {
      headers: auth(admin.accessToken),
    });
    expect(await payload<NoteRow[]>(withNote)).toHaveLength(4);

    // The worklist: called, never written up. `hasNote=false` must not read as
    // true — a boolean-typed DTO field would, because Boolean('false') is true.
    const withoutNote = await request.get('/admin/growth/notes?hasNote=false', {
      headers: auth(admin.accessToken),
    });
    const gap = await payload<NoteRow[]>(withoutNote);
    expect(gap).toHaveLength(2);
    expect(gap.every((r) => !r.hasNote)).toBe(true);
  });

  test('the notes list pages, filters by call date, and refuses bad bounds', async ({
    request,
  }) => {
    await seedCohort();

    const firstPage = await request.get('/admin/growth/notes?page=1&limit=4', {
      headers: auth(admin.accessToken),
    });
    expect(firstPage.status(), await firstPage.text()).toBe(200);
    const page1 = await payload<NoteRow[]>(firstPage);
    const meta = await pagination(firstPage);
    expect(page1).toHaveLength(4);
    expect(meta.totalItems).toBe(6);
    expect(meta.totalPages).toBe(2);
    expect(meta.hasNextPage).toBe(true);

    const secondPage = await request.get('/admin/growth/notes?page=2&limit=4', {
      headers: auth(admin.accessToken),
    });
    const page2 = await payload<NoteRow[]>(secondPage);
    expect(page2).toHaveLength(2);
    // No row may appear on both pages: the sort has a unique trailing key
    // precisely so rows sharing a timestamp cannot reorder between requests.
    const ids = new Set([...page1, ...page2].map((r) => r.userId));
    expect(ids.size).toBe(6);

    // calledSince clips the list to recent work. The cohort's calls run from 15
    // days back to 12; 13 days back keeps the two most recent.
    const since = new Date(Date.now() - 13 * DAY_MS - 60_000).toISOString();
    const recent = await request.get(
      `/admin/growth/notes?calledSince=${encodeURIComponent(since)}`,
      { headers: auth(admin.accessToken) },
    );
    expect((await payload<NoteRow[]>(recent)).length).toBe(4);

    const rejected: [string, number][] = [
      ['/admin/growth/notes?page=0', 400],
      ['/admin/growth/notes?limit=0', 400],
      ['/admin/growth/notes?limit=101', 400],
      ['/admin/growth/notes?page=abc', 400],
      ['/admin/growth/notes?calledSince=2026-13-45', 400],
      ['/admin/growth/notes?sortBy=adminCallNotes', 400],
      // Deeper than MAX_OFFSET. Offset pagination degrades linearly with depth,
      // so a client looping to export is refused rather than pinning a core.
      ['/admin/growth/notes?page=100000&limit=100', 400],
    ];
    for (const [url, status] of rejected) {
      const res = await request.get(url, { headers: auth(admin.accessToken) });
      expect(res.status(), `${url} -> ${await res.text()}`).toBe(status);
    }
  });

  test('the default window is the last 30 IST days and says so', async ({
    request,
  }) => {
    // Two accounts registered through the API moments ago — the admin and the
    // customer. Only one of them is a customer, and that is the whole assertion.
    const body = await growth(request, admin.accessToken, '/admin/growth');

    expect(body.window.defaulted).toBe(true);
    expect(body.window.granularity).toBe('day');
    expect(body.window.timezone).toBe('Asia/Kolkata');
    expect(body.window.buckets).toBe(30);
    expect(body.signups.total).toBe(1);
    expect(body.asOf.windowHasData).toBe(true);
    expect(body.asOf.customersAllTime).toBe(1);

    // Nobody has called the one signup, and that is a real 0% — a denominator of
    // one is enough to say so. The contract is "null when undefined", not
    // "never zero".
    expect(body.calling.coverage.value).toBe(0);
    expect(body.calling.coverage.sufficient).toBe(true);
    expect(body.calling.coverage.reason).toBeNull();
  });
});
