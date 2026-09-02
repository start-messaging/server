import { test, expect } from '@playwright/test';
import { resetDb, closeDb, sql } from '../helpers/db.js';
import {
  createAdmin,
  createCustomer,
  payload,
  auth,
  Customer,
} from '../helpers/actors.js';
import {
  FIXTURE_PORT,
  errorOf,
  paginationOf,
  pollIngestRun,
  startFixtureServer,
  triggerIngest,
} from './helpers.js';

/**
 * The NRD ingest: one day's file in, filtered and scored leads out.
 *
 * The fixture server serves the file as plain text — nrd-ingest treats any
 * body that does not start with the zip magic 'PK' as the text itself, which
 * is the documented seam for tests and mirrors. Every filter branch of
 * nrd-filter.ts gets one line below: keepers on both a bare and a compound
 * TLD, a disallowed TLD, punycode, a vowelless DGA string, a duplicate, and
 * blank lines that must not count as domains.
 */

const FILE_DATE = '2026-01-05';
const MISSING_DATE = '2026-01-06';
/** Days the `days: 3` backfill walks, newest first, starting at FILE_DATE. */
const BACKFILL_DATES = ['2026-01-05', '2026-01-04', '2026-01-03'];
/** The admin-chosen date for the aggregate-URL import. */
const AGGREGATE_DATE = '2026-01-01';

/**
 * Eleven non-blank lines, six of which survive classifyDomain:
 *  - flowershopdelhi.in   kept; 'shop' keyword + 'delhi' India token →
 *                         score 2, isIndian true (.in)
 *  - kiranamart.co.in     kept; co.in resolves as a compound TLD, 'kirana'
 *                         and 'mart' are keywords → score 2, isIndian true
 *  - mumbaitailors.com    kept; the 'mumbai' India token marks it Indian
 *                         from the name and scores it → score 1
 *  - shopnow.com          kept; the 'shop' keyword scores it → score 1,
 *                         isIndian NULL for enrichment
 *  - randomword.com       kept; SEMANTIC CHANGE (ingest-all): a generic-TLD
 *                         domain with neither keyword nor India token used
 *                         to be dropped, but the feed files expire in ~10
 *                         days so a skipped domain was lost forever → now
 *                         kept with score 0, isIndian NULL
 *  - abc123x.top          dropped: .top is in no TLD list (default-deny —
 *                         what keeps the spam TLDs out under ingest-all)
 *  - foo.de               dropped: .de is a blocked foreign ccTLD
 *  - foo.pk               dropped: .pk likewise
 *  - xn--foo.in           dropped: punycode is rejected outright
 *  - nh2rpr8p.in          dropped: no vowel in the second-level label
 *  - flowershopdelhi.in   kept again (matched counts it), but ON CONFLICT
 *                         DO NOTHING means it inserts nothing
 */
const NRD_FILE = [
  'flowershopdelhi.in',
  'kiranamart.co.in',
  '',
  'mumbaitailors.com',
  'shopnow.com',
  'randomword.com',
  'abc123x.top',
  'foo.de',
  'foo.pk',
  'xn--foo.in',
  'nh2rpr8p.in',
  '',
  'flowershopdelhi.in',
  '',
].join('\n');

test.describe('NRD ingest', () => {
  let fixture: { close(): Promise<void> };
  let admin: Customer;

  test.beforeAll(async () => {
    // No route for MISSING_DATE on purpose — that 404 is a fixture too.
    fixture = await startFixtureServer({
      [`/nrd/${FILE_DATE}.txt`]: {
        body: NRD_FILE,
        contentType: 'text/plain',
      },
      // The two extra days the `days: 3` backfill walks into. Same body on
      // purpose: leads dedupe across days, so the three runs together must
      // still produce one row per unique domain.
      [`/nrd/${BACKFILL_DATES[1]}.txt`]: {
        body: NRD_FILE,
        contentType: 'text/plain',
      },
      [`/nrd/${BACKFILL_DATES[2]}.txt`]: {
        body: NRD_FILE,
        contentType: 'text/plain',
      },
      // Stands in for the 60-day aggregate mirror an admin can point one run
      // at via the `url` override.
      '/agg/aggregate.txt': {
        body: ['aggshop.in', 'foo.de', ''].join('\n'),
        contentType: 'text/plain',
      },
    });
  });

  test.afterAll(async () => {
    // Serial suite, shared port 41100: the next spec file's beforeAll can
    // only bind if this one lets go.
    await fixture.close();
    await closeDb();
  });

  test.beforeEach(async ({ request }) => {
    await resetDb();
    admin = await createAdmin(request);
  });

  test('one file date is fetched, filtered, scored and inserted', async ({
    request,
  }) => {
    const res = await triggerIngest(request, admin.accessToken, FILE_DATE);
    // Plain @Post with no @HttpCode, so Nest's default 201.
    expect(res.status(), await res.text()).toBe(201);
    // The single-date response keeps `fileDate` (the panel's toast reads it)
    // alongside the list the backfill path introduced.
    expect(await payload(res)).toEqual({
      enqueued: true,
      fileDate: FILE_DATE,
      fileDates: [FILE_DATE],
    });

    const run = await pollIngestRun(request, admin.accessToken, FILE_DATE);
    expect(run.status).toBe('completed');
    expect(run.totalDomains, 'blank lines must not count').toBe(11);
    expect(run.matchedDomains, 'the duplicate line still matches').toBe(6);
    expect(run.insertedDomains, 'the duplicate must not insert').toBe(5);
    expect(run.error).toBeNull();
    expect(run.finishedAt).not.toBeNull();

    // No tld column anymore — the effective TLD (compound co.in included)
    // decides keep/drop inside the classifier and is not persisted; its
    // resolution stays pinned by nrd-filter.spec.ts.
    const rows = await sql<{
      domain: string;
      isIndian: boolean;
      registeredOn: string;
      score: number;
      status: string;
      enrichmentStatus: string;
    }>(
      `SELECT "domain", "isIndian", "registeredOn"::text AS "registeredOn",
              "score", "status", "enrichmentStatus"
         FROM "leads" ORDER BY "domain"`,
    );
    expect(rows).toEqual([
      {
        // 'shop' keyword + 'delhi' India token — the token scores too.
        domain: 'flowershopdelhi.in',
        isIndian: true,
        registeredOn: FILE_DATE,
        score: 2,
        status: 'new',
        enrichmentStatus: 'pending',
      },
      {
        // The compound TLD resolved as co.in (not in): still kept as Indian
        // by construction, keyword score off 'kiranamart'.
        domain: 'kiranamart.co.in',
        isIndian: true,
        registeredOn: FILE_DATE,
        score: 2,
        status: 'new',
        enrichmentStatus: 'pending',
      },
      {
        // A generic TLD whose name carries an India token, but not as a name of
        // its own — 'mumbai' runs straight into 'tailors' with nothing between
        // them. The token still SCORES, so this sorts up the crawl queue ahead
        // of an unremarkable .com; it just no longer ESTABLISHES the country.
        //
        // That split is deliberate. Establishing it on a bare substring was
        // marking 'designstudio' Indian off 'desi' and 'goalsetter' off 'goa' —
        // ~1,956 domains in the development database, most of them the English
        // word "design" — and nothing downstream ever downgrades isIndian. A
        // missed one costs nothing by comparison: the domain is crawled early
        // anyway and the page's own ₹ prices, IN phone numbers or Razorpay SDK
        // settle it. See containsTokenAtBoundary in nrd-filter.ts.
        domain: 'mumbaitailors.com',
        isIndian: null,
        registeredOn: FILE_DATE,
        score: 1,
        status: 'new',
        enrichmentStatus: 'pending',
      },
      {
        // Ingest-all: no keyword, no India token — kept anyway. Score 0
        // parks it at the back of the crawl queue; the crawler decides the
        // country later. (This domain was dropped before this phase.)
        domain: 'randomword.com',
        isIndian: null,
        registeredOn: FILE_DATE,
        score: 0,
        status: 'new',
        enrichmentStatus: 'pending',
      },
      {
        // The keyword scores it, but a .com with 'shop' could be anywhere:
        // isIndian stays NULL until enrichment finds an India signal.
        domain: 'shopnow.com',
        isIndian: null,
        registeredOn: FILE_DATE,
        score: 1,
        status: 'new',
        enrichmentStatus: 'pending',
      },
    ]);
  });

  test('re-triggering a completed day returns the run untouched', async ({
    request,
  }) => {
    await triggerIngest(request, admin.accessToken, FILE_DATE);
    const first = await pollIngestRun(request, admin.accessToken, FILE_DATE);
    expect(first.status).toBe('completed');

    const [before] = await sql<{ updatedAt: string; finishedAt: string }>(
      `SELECT "updatedAt"::text AS "updatedAt", "finishedAt"::text AS "finishedAt"
         FROM "lead_ingest_runs" WHERE "id" = $1`,
      [first.id],
    );

    const again = await triggerIngest(request, admin.accessToken, FILE_DATE);
    expect(again.status(), await again.text()).toBe(201);

    // runForDate's claim is an ON CONFLICT DO UPDATE whose WHERE refuses
    // 'completed', so the second job returns the existing run without
    // writing anything — not even updatedAt. Nothing observable changes, so
    // the assertion is a settle-and-compare rather than a poll.
    await new Promise((r) => setTimeout(r, 1_500));

    const [after] = await sql<{
      status: string;
      insertedDomains: number;
      updatedAt: string;
      finishedAt: string;
    }>(
      `SELECT "status", "insertedDomains", "updatedAt"::text AS "updatedAt",
              "finishedAt"::text AS "finishedAt"
         FROM "lead_ingest_runs" WHERE "id" = $1`,
      [first.id],
    );
    expect(after.status).toBe('completed');
    expect(after.insertedDomains).toBe(5);
    expect(after.updatedAt).toBe(before.updatedAt);
    expect(after.finishedAt).toBe(before.finishedAt);

    const [{ count }] = await sql<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM "leads"`,
    );
    expect(count, 're-ingest must not duplicate leads').toBe(5);

    const [{ runs }] = await sql<{ runs: number }>(
      `SELECT COUNT(*)::int AS runs FROM "lead_ingest_runs"`,
    );
    expect(runs, 'one run row per file date').toBe(1);
  });

  test('force: true re-runs a completed day without touching existing leads', async ({
    request,
  }) => {
    // The backfill path for when the ingest FILTER changed after a day
    // already ran (ingest-all widened what a file yields): force re-opens
    // the completed day, and ON CONFLICT DO NOTHING guarantees the re-run
    // only ever ADDS newly-admitted domains.
    await triggerIngest(request, admin.accessToken, FILE_DATE);
    const first = await pollIngestRun(request, admin.accessToken, FILE_DATE);
    expect(first.status).toBe('completed');
    expect(first.insertedDomains).toBe(5);

    const [firstFinished] = await sql<{ finishedAt: string }>(
      `SELECT "finishedAt"::text AS "finishedAt"
         FROM "lead_ingest_runs" WHERE "id" = $1`,
      [first.id],
    );

    const forced = await request.post('/admin/leads/ingest/run', {
      data: { date: FILE_DATE, force: true },
      headers: auth(admin.accessToken),
    });
    expect(forced.status(), await forced.text()).toBe(201);

    // The run row is re-claimed and re-finished: same row (unique per file
    // date), fresh finish stamp, and this run's honest counts — everything
    // matched again, nothing was new to insert.
    await expect
      .poll(async () => {
        const [row] = await sql<{ finishedAt: string | null }>(
          `SELECT "finishedAt"::text AS "finishedAt"
             FROM "lead_ingest_runs" WHERE "id" = $1`,
          [first.id],
        );
        return row.finishedAt;
      })
      .not.toBe(firstFinished.finishedAt);

    const rerun = await pollIngestRun(request, admin.accessToken, FILE_DATE);
    expect(rerun.id, 'same run row, re-opened').toBe(first.id);
    expect(rerun.status).toBe('completed');
    expect(rerun.matchedDomains).toBe(6);
    expect(rerun.insertedDomains, 'every domain already existed').toBe(0);

    const [{ count }] = await sql<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM "leads"`,
    );
    expect(count, 'a forced re-run must not duplicate leads').toBe(5);
  });

  test('days: 3 walks backwards and runs one ingest per file date', async ({
    request,
  }) => {
    const res = await request.post('/admin/leads/ingest/run', {
      data: { date: FILE_DATE, days: 3 },
      headers: auth(admin.accessToken),
    });
    expect(res.status(), await res.text()).toBe(201);
    // Multi-date: the list, newest first; no single `fileDate` to toast.
    expect(await payload(res)).toEqual({
      enqueued: true,
      fileDates: BACKFILL_DATES,
    });

    for (const date of BACKFILL_DATES) {
      const run = await pollIngestRun(request, admin.accessToken, date);
      expect(run.status, `run for ${date}`).toBe('completed');
      expect(run.matchedDomains).toBe(6);
    }

    // The three days serve the same fixture body, and the worker may process
    // them concurrently — the per-run insert split is nondeterministic, but
    // UQ_leads_domain guarantees the union: one row per unique domain.
    const [{ count }] = await sql<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM "leads"`,
    );
    expect(count).toBe(5);
    const [{ runs }] = await sql<{ runs: number }>(
      `SELECT COUNT(*)::int AS runs FROM "lead_ingest_runs"`,
    );
    expect(runs).toBe(3);
  });

  test('a url override fetches the admin-named source for one run', async ({
    request,
  }) => {
    // 127.0.0.1 is only allowed because .env.e2e runs NODE_ENV=test — the
    // fixture seam of the SSRF allowlist.
    const res = await request.post('/admin/leads/ingest/run', {
      data: {
        date: AGGREGATE_DATE,
        url: `http://127.0.0.1:${FIXTURE_PORT}/agg/aggregate.txt`,
      },
      headers: auth(admin.accessToken),
    });
    expect(res.status(), await res.text()).toBe(201);

    const run = await pollIngestRun(request, admin.accessToken, AGGREGATE_DATE);
    expect(run.status).toBe('completed');
    expect(run.totalDomains).toBe(2);
    expect(run.matchedDomains, 'foo.de stays blocked in an aggregate').toBe(1);
    expect(run.insertedDomains).toBe(1);

    // Aggregate imports carry an approximate registeredOn: the date the
    // admin chose, since a multi-day file has no per-domain date.
    const rows = await sql<{ domain: string; registeredOn: string }>(
      `SELECT "domain", "registeredOn"::text AS "registeredOn" FROM "leads"`,
    );
    expect(rows).toEqual([
      { domain: 'aggshop.in', registeredOn: AGGREGATE_DATE },
    ]);
  });

  test('a url outside the host allowlist is refused with zero runs', async ({
    request,
  }) => {
    const res = await request.post('/admin/leads/ingest/run', {
      data: { date: FILE_DATE, url: 'https://evil.example/x' },
      headers: auth(admin.accessToken),
    });
    expect(res.status(), await res.text()).toBe(400);
    const error = await errorOf(res);
    expect(error.code).toBe('VALIDATION_ERROR');
    expect(error.message).toContain('whoisds.com');

    // Refused before anything was enqueued: no run row, no leads.
    const [{ runs }] = await sql<{ runs: number }>(
      `SELECT COUNT(*)::int AS runs FROM "lead_ingest_runs"`,
    );
    expect(runs).toBe(0);
    const [{ count }] = await sql<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM "leads"`,
    );
    expect(count).toBe(0);
  });

  test('a date whose file is missing ends the run failed with HTTP 404', async ({
    request,
  }) => {
    await triggerIngest(request, admin.accessToken, MISSING_DATE);
    const run = await pollIngestRun(request, admin.accessToken, MISSING_DATE);

    // Recorded, not thrown: a 404 usually just means WhoisDS has not
    // published yet, and the hourly retry window will re-claim this row.
    expect(run.status).toBe('failed');
    expect(run.error).toBe('HTTP 404');
    expect(run.totalDomains).toBe(0);
    expect(run.insertedDomains).toBe(0);

    const [{ count }] = await sql<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM "leads"`,
    );
    expect(count).toBe(0);
  });

  test('the run listing is newest file date first, paginated, with the row an operator reads', async ({
    request,
  }) => {
    // Until now this route was only ever touched by pollIngestRun's loop, so
    // its own contract — ordering, envelope, row shape — had no assertion.
    // Three runs seeded straight into the table, deliberately inserted out of
    // date order so the ORDER BY is doing the work, not insertion order.
    await sql(
      `INSERT INTO "lead_ingest_runs"
         ("fileDate", "status", "totalDomains", "matchedDomains",
          "insertedDomains", "error", "finishedAt")
       VALUES ('2026-01-02', 'completed', 100, 10, 8, NULL, '2026-01-03T04:00:00Z'),
              ('2026-01-04', 'failed', 0, 0, 0, 'HTTP 404', '2026-01-05T04:00:00Z'),
              ('2026-01-03', 'completed', 50, 5, 5, NULL, '2026-01-04T04:00:00Z')`,
    );

    const res = await request.get('/admin/leads/ingest-runs', {
      headers: auth(admin.accessToken),
    });
    expect(res.status(), await res.text()).toBe(200);

    const rows = await payload<
      {
        fileDate: string;
        status: string;
        totalDomains: number;
        matchedDomains: number;
        insertedDomains: number;
        error: string | null;
        finishedAt: string | null;
      }[]
    >(res);
    expect(
      rows.map((r) => String(r.fileDate).slice(0, 10)),
      'the listing is not newest-file-date-first',
    ).toEqual(['2026-01-04', '2026-01-03', '2026-01-02']);

    // The row an operator acts on: counts, the recorded error, the finish
    // stamp — asserted on the failed run because that is the one that gets
    // read under pressure.
    const failed = rows[0];
    expect(failed.status).toBe('failed');
    expect(failed.error).toBe('HTTP 404');
    expect(failed.totalDomains).toBe(0);
    expect(failed.insertedDomains).toBe(0);
    expect(failed.finishedAt).not.toBeNull();
    const completed = rows[1];
    expect(completed.status).toBe('completed');
    expect(completed.totalDomains).toBe(50);
    expect(completed.matchedDomains).toBe(5);
    expect(completed.insertedDomains).toBe(5);
    expect(completed.error).toBeNull();

    // The pagination envelope, and a page walk that honours the same order.
    const meta = await paginationOf(res);
    expect(meta.page).toBe(1);
    expect(meta.totalItems).toBe(3);
    expect(meta.totalPages).toBe(1);
    expect(meta.hasNextPage).toBe(false);

    const secondPage = await request.get(
      '/admin/leads/ingest-runs?page=2&limit=1',
      { headers: auth(admin.accessToken) },
    );
    const secondRows = await payload<{ fileDate: string }[]>(secondPage);
    expect(secondRows.map((r) => String(r.fileDate).slice(0, 10))).toEqual([
      '2026-01-03',
    ]);
    const secondMeta = await paginationOf(secondPage);
    expect(secondMeta.totalItems).toBe(3);
    expect(secondMeta.hasNextPage).toBe(true);
    expect(secondMeta.hasPreviousPage).toBe(true);
  });

  test('only an admin session may trigger an ingest', async ({ request }) => {
    const anonymous = await request.post('/admin/leads/ingest/run', {
      data: { date: FILE_DATE },
    });
    expect(anonymous.status()).toBe(401);
    expect((await errorOf(anonymous)).code).toBe('UNAUTHORIZED');

    const customer = await createCustomer(request);
    const asCustomer = await request.post('/admin/leads/ingest/run', {
      data: { date: FILE_DATE },
      headers: auth(customer.accessToken),
    });
    expect(asCustomer.status()).toBe(403);
    expect((await errorOf(asCustomer)).code).toBe('FORBIDDEN');

    const [{ runs }] = await sql<{ runs: number }>(
      `SELECT COUNT(*)::int AS runs FROM "lead_ingest_runs"`,
    );
    expect(runs, 'a refused trigger must not enqueue anything').toBe(0);
  });
});
