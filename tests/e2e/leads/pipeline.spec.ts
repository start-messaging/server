import { test, expect, APIRequestContext } from '@playwright/test';
import { resetDb, closeDb, sql } from '../helpers/db.js';
import {
  createAdmin,
  createCustomer,
  payload,
  auth,
  Customer,
} from '../helpers/actors.js';
import {
  errorOf,
  leadRow,
  parkedPageHtml,
  seedLead,
  sitePageHtml,
  startFixtureServer,
} from './helpers.js';

/**
 * The pipeline visibility surface (GET /admin/leads/pipeline) and the manual
 * sweep trigger (POST /admin/leads/enrich-sweep/run) — the API half of the
 * panel's queue/cron page with its rerun button. The sweep trigger is also
 * how the queue-path behaviours are driven end-to-end here: parked leads
 * never escalating to the browser tier, and the weekly parked recheck.
 */

const SWEEPABLE = 'sweepable-blooms.e2e-fixture.in';
const PARKED_QUEUED = 'parked-queued.e2e-fixture.in';
const RELAUNCHED = 'relaunched-blooms.e2e-fixture.in';
const STILL_PARKED = 'still-parked.e2e-fixture.in';
const RECRAWL_STALE = 'recrawl-stale.e2e-fixture.in';
const RECRAWL_FRESH = 'recrawl-fresh.e2e-fixture.in';

function triggerSweep(request: APIRequestContext, token: string) {
  return request.post('/admin/leads/enrich-sweep/run', {
    headers: auth(token),
  });
}

test.describe('leads pipeline endpoint', () => {
  let fixture: { close(): Promise<void> };
  let admin: Customer;

  test.beforeAll(async () => {
    fixture = await startFixtureServer({
      [`/site/${SWEEPABLE}`]: {
        body: sitePageHtml({
          domain: SWEEPABLE,
          email: 'owner@sweepable-mail.in',
        }),
      },
      [`/site/${PARKED_QUEUED}`]: { body: parkedPageHtml() },
      // The recheck target: was parked, has since launched a real site.
      [`/site/${RELAUNCHED}`]: {
        body: sitePageHtml({
          domain: RELAUNCHED,
          email: 'owner@relaunched-mail.in',
        }),
      },
      [`/site/${STILL_PARKED}`]: { body: parkedPageHtml() },
      // The re-crawl cycle's target: an already-enriched lead whose site now
      // shows a contact its first crawl never saw.
      [`/site/${RECRAWL_STALE}`]: {
        body: sitePageHtml({
          domain: RECRAWL_STALE,
          email: 'fresh@recrawl-mail.in',
        }),
      },
      [`/site/${RECRAWL_FRESH}`]: {
        body: sitePageHtml({ domain: RECRAWL_FRESH }),
      },
    });
  });

  test.afterAll(async () => {
    // Serial suite, shared port 41100 — close so the next spec can bind.
    await fixture.close();
    await closeDb();
  });

  test.beforeEach(async ({ request }) => {
    await resetDb();
    admin = await createAdmin(request);
  });

  test('the pipeline view names both crons (disabled here), counts and job lists', async ({
    request,
  }) => {
    const res = await request.get('/admin/leads/pipeline', {
      headers: auth(admin.accessToken),
    });
    expect(res.status(), await res.text()).toBe(200);
    const body = await payload<any>(res);

    // The three schedulers in pipeline-flow order (ingest → probe → crawl),
    // a stable order the panel can rely on. No gate is set in .env.e2e, so
    // all report disabled — the exact state an operator must be able to SEE
    // (silently-not-running was the complaint this endpoint answers).
    expect(body.crons.map((c: any) => c.id)).toEqual([
      'leads-nrd-sweep',
      'leads-liveness-sweep',
      'leads-enrich-sweep',
    ]);
    for (const cron of body.crons) {
      expect(cron.enabled).toBe(false);
      expect(typeof cron.label).toBe('string');
      expect(typeof cron.schedule).toBe('string');
      // Read defensively from Redis: an ISO stamp when the scheduler is
      // registered, null when it is not (or Redis is briefly away).
      expect('next' in cron).toBe(true);
      if (cron.next !== null) {
        expect(new Date(cron.next).toString()).not.toBe('Invalid Date');
      }
    }

    // The queue counters the panel charts. Values vary with what earlier
    // specs left behind; the contract is the keys and their type.
    for (const key of ['waiting', 'active', 'delayed', 'failed', 'completed']) {
      expect(typeof body.counts[key], `counts.${key}`).toBe('number');
    }

    for (const list of ['active', 'waiting', 'delayed', 'failed']) {
      expect(Array.isArray(body.jobs[list]), `jobs.${list}`).toBe(true);
    }

    // The drain's order book — "how many will it do, how many done". A
    // fresh resetDb means every pool reads zero, exactly.
    const enrichment = body.enrichment;
    expect(enrichment.running).toBe(false);
    expect(enrichment.startedAt).toBeNull();
    expect(enrichment.processedThisRun).toBe(0);
    expect(enrichment.todo).toEqual({
      pendingLive: 0,
      staleRecrawl: 0,
      parkedRecheckDue: 0,
    });
    expect(enrichment.done).toEqual({ crawledLast24h: 0 });
    // The effective runtime settings the panel header renders — env
    // defaults here, since no override is stored.
    expect(enrichment.settings).toEqual({
      enabled: false,
      batchPerSweep: 500,
      concurrency: 4,
      recrawlHours: 48,
    });
  });

  test('the pipeline view and the sweep trigger are admin-only', async ({
    request,
  }) => {
    const anonymous = await request.get('/admin/leads/pipeline');
    expect(anonymous.status()).toBe(401);
    expect((await errorOf(anonymous)).code).toBe('UNAUTHORIZED');

    const customer = await createCustomer(request);
    const asCustomer = await request.get('/admin/leads/pipeline', {
      headers: auth(customer.accessToken),
    });
    expect(asCustomer.status()).toBe(403);
    expect((await errorOf(asCustomer)).code).toBe('FORBIDDEN');

    const runAsCustomer = await triggerSweep(request, customer.accessToken);
    expect(runAsCustomer.status()).toBe(403);
    expect((await errorOf(runAsCustomer)).code).toBe('FORBIDDEN');
  });

  test('enrich-sweep/run sweeps a pending lead through to enriched', async ({
    request,
  }) => {
    // liveness 'live': the sweep claims probed-live leads only now — a lead
    // the prober has not passed yet is deferred, not crawled.
    const lead = await seedLead({
      domain: SWEEPABLE,
      isIndian: null,
      liveness: 'live',
    });

    // The scheduler gate (LEADS_ENRICH_ENABLED) is off in this env — the
    // manual trigger works anyway: env gates decide what runs unattended,
    // an admin's explicit click is its own authorization.
    const res = await triggerSweep(request, admin.accessToken);
    expect(res.status(), await res.text()).toBe(201);
    expect(await payload(res)).toEqual({ enqueued: true });

    await expect
      .poll(async () => (await leadRow(lead.id)).enrichmentStatus, {
        timeout: 30_000,
      })
      .toBe('enriched');
    expect((await leadRow(lead.id)).contactEmails).toEqual([
      'owner@sweepable-mail.in',
    ]);
  });

  test('a parked lead is never escalated to the browser tier', async ({
    request,
  }) => {
    // Queue path on purpose: the browser gate IS on in .env.e2e, so if the
    // parked page wrongly ended no_contact the worker would escalate and
    // browserAttemptedAt would fill — this pins that parked short-circuits
    // the escalation (rendering a parking template could only harvest more
    // of the registrar's junk). Seeded live so the sweep claims it.
    const lead = await seedLead({
      domain: PARKED_QUEUED,
      isIndian: null,
      liveness: 'live',
    });

    const res = await triggerSweep(request, admin.accessToken);
    expect(res.status(), await res.text()).toBe(201);

    await expect
      .poll(async () => (await leadRow(lead.id)).enrichmentStatus, {
        timeout: 30_000,
      })
      .toBe('parked');

    // Give a wrongly-queued browser job ample time to have run…
    await new Promise((r) => setTimeout(r, 3_000));

    const stored = await leadRow(lead.id);
    expect(stored.browserAttemptedAt, 'parked must never render').toBeNull();
    expect(stored.enrichmentStatus).toBe('parked');
    expect(stored.contactEmails).toEqual([]);
  });

  test('the sweep rechecks stale parked leads and catches a launch', async ({
    request,
  }) => {
    // Two parked leads: one checked 8 days ago whose site has since gone
    // live, one checked just now. Only the stale one is older than
    // LEADS_PARKED_RECHECK_DAYS (7), so only it is re-crawled — and a
    // recheck that finds a real site proceeds through normal enrichment.
    const stale = await seedLead({
      domain: RELAUNCHED,
      enrichmentStatus: 'parked',
    });
    const fresh = await seedLead({
      domain: STILL_PARKED,
      enrichmentStatus: 'parked',
    });
    await sql(
      `UPDATE "leads" SET "enrichedAt" = now() - interval '8 days' WHERE "id" = $1`,
      [stale.id],
    );
    await sql(`UPDATE "leads" SET "enrichedAt" = now() WHERE "id" = $1`, [
      fresh.id,
    ]);

    const res = await triggerSweep(request, admin.accessToken);
    expect(res.status(), await res.text()).toBe(201);

    await expect
      .poll(async () => (await leadRow(stale.id)).enrichmentStatus, {
        timeout: 30_000,
      })
      .toBe('enriched');
    expect((await leadRow(stale.id)).contactEmails).toEqual([
      'owner@relaunched-mail.in',
    ]);

    // The fresh one was not claimed: still parked, never re-attempted.
    const untouched = await leadRow(fresh.id);
    expect(untouched.enrichmentStatus).toBe('parked');
    expect(untouched.enrichmentAttempts).toBe(0);
  });

  test('the drain re-crawls leads whose last crawl is older than the window', async ({
    request,
  }) => {
    // The 48h re-crawl cycle: sites change, contacts appear. One lead
    // crawled 3 days ago whose site now shows an email its first crawl
    // never stored, one crawled an hour ago — only the stale one re-enters.
    const stale = await seedLead({
      domain: RECRAWL_STALE,
      liveness: 'live',
      enrichmentStatus: 'enriched',
    });
    const fresh = await seedLead({
      domain: RECRAWL_FRESH,
      liveness: 'live',
      enrichmentStatus: 'enriched',
    });
    await sql(
      `UPDATE "leads" SET "enrichedAt" = now() - interval '3 days' WHERE "id" = $1`,
      [stale.id],
    );
    await sql(
      `UPDATE "leads" SET "enrichedAt" = now() - interval '1 hour' WHERE "id" = $1`,
      [fresh.id],
    );
    const freshBefore = (await leadRow(fresh.id)).enrichedAt;

    const res = await triggerSweep(request, admin.accessToken);
    expect(res.status(), await res.text()).toBe(201);

    // The re-crawl found what the (fictional) first crawl never saw, and
    // union-merged it in — a re-crawl only ever adds.
    await expect
      .poll(async () => (await leadRow(stale.id)).contactEmails, {
        timeout: 30_000,
      })
      .toEqual(['fresh@recrawl-mail.in']);
    const restamped = await leadRow(stale.id);
    expect(restamped.enrichmentStatus).toBe('enriched');
    expect(restamped.enrichedAt).not.toBeNull();

    // The hour-old lead was not due: same clock, untouched.
    const untouched = await leadRow(fresh.id);
    expect(untouched.enrichedAt).toBe(freshBefore);
    expect(untouched.enrichmentAttempts).toBe(0);
  });

  test('runtime settings: env defaults, panel overrides, null reverts', async ({
    request,
  }) => {
    const get = (token: string) =>
      request.get('/admin/leads/settings', { headers: auth(token) });
    const patch = (data: Record<string, unknown>) =>
      request.patch('/admin/leads/settings', {
        data,
        headers: auth(admin.accessToken),
      });

    // Shipped state: nothing stored, every effective value is the env
    // default — the row overrides nothing until an admin writes to it. The
    // three blocks share one key set (the panel's form is a single loop).
    const initial = await get(admin.accessToken);
    expect(initial.status(), await initial.text()).toBe(200);
    const before = await payload<any>(initial);
    expect(before.stored).toEqual({
      ingestEnabled: null,
      livenessEnabled: null,
      enrichEnabled: null,
      enrichBatchPerSweep: null,
      enrichConcurrency: null,
      enrichRecrawlHours: null,
    });
    expect(before.effective).toEqual(before.defaults);
    expect(before.effective.enrichRecrawlHours).toBe(48);
    // Every stage gate lives here now — DB-operated, env only as default.
    expect(before.effective.ingestEnabled).toBe(false);
    expect(before.effective.livenessEnabled).toBe(false);

    // Overrides win field by field; untouched fields keep their defaults.
    const updated = await patch({
      livenessEnabled: true,
      enrichEnabled: true,
      enrichConcurrency: 2,
      enrichRecrawlHours: 24,
    });
    expect(updated.status(), await updated.text()).toBe(200);
    const after = await payload<any>(updated);
    expect(after.effective.livenessEnabled).toBe(true);
    expect(after.effective.enrichEnabled).toBe(true);
    expect(after.effective.enrichConcurrency).toBe(2);
    expect(after.effective.enrichRecrawlHours).toBe(24);
    expect(after.effective.enrichBatchPerSweep, 'untouched → default').toBe(
      500,
    );
    expect(after.effective.ingestEnabled, 'untouched gate → default').toBe(
      false,
    );
    expect(after.stored.enrichConcurrency).toBe(2);

    // Out-of-range dies in the DTO (and would die on the CHECK anyway).
    for (const bad of [
      { enrichConcurrency: 0 },
      { enrichConcurrency: 99 },
      { enrichRecrawlHours: 0 },
      { enrichBatchPerSweep: 0 },
    ]) {
      const res = await patch(bad);
      expect(res.status(), JSON.stringify(bad)).toBe(400);
      expect((await errorOf(res)).code).toBe('VALIDATION_ERROR');
    }

    // null reverts a field to its env default — and doing it for every
    // field also drops the service's settings cache, so later tests start
    // from the shipped state deterministically.
    const cleared = await patch({
      livenessEnabled: null,
      enrichEnabled: null,
      enrichConcurrency: null,
      enrichRecrawlHours: null,
    });
    expect(cleared.status(), await cleared.text()).toBe(200);
    const reverted = await payload<any>(cleared);
    expect(reverted.stored.enrichEnabled).toBeNull();
    expect(reverted.effective.livenessEnabled).toBe(false);
    expect(reverted.effective.enrichEnabled).toBe(false);
    expect(reverted.effective.enrichConcurrency).toBe(4);
    expect(reverted.effective.enrichRecrawlHours).toBe(48);

    // Admin-only, like every other knob on this controller.
    const customer = await createCustomer(request);
    const asCustomer = await get(customer.accessToken);
    expect(asCustomer.status()).toBe(403);
    const patchAsCustomer = await request.patch('/admin/leads/settings', {
      data: { enrichEnabled: true },
      headers: auth(customer.accessToken),
    });
    expect(patchAsCustomer.status()).toBe(403);
  });
});

/**
 * The self-healing branch in LeadsSettingsService.row() is the one that has to
 * work under concurrency, because the situation it exists for — a fresh or
 * partially-restored database — is exactly the situation where several callers
 * arrive at once: the enrich sweep on its schedule, the liveness sweep on
 * hers, and an operator opening the Pipeline page to find out what is going on.
 *
 * It used to save() blind, so the loser of that race died on
 * UQ_lead_pipeline_settings_singleton. `effective()` is the first statement of
 * both GET /admin/leads/pipeline and GET /admin/leads/settings, so it surfaced
 * as a 500 on the two pages an operator opens when the pipeline looks stuck —
 * caught by a browser sweep, never by a serial API test.
 */
test.describe('lead pipeline settings singleton', () => {
  let admin: Customer;

  test.beforeAll(async ({ request }) => {
    await resetDb();
    admin = await createAdmin(request);
  });

  /**
   * The row is a suite-wide fixture, not this file's property: helpers/db.ts
   * resets it with an UPDATE and every later spec assumes it exists. This test
   * has to delete it to reach the branch, so putting it back is not tidiness —
   * without it, the next file's PATCH hits findOneOrFail on nothing and 500s.
   */
  test.afterAll(async () => {
    await sql(
      `INSERT INTO "lead_pipeline_settings" ("isSingleton")
       VALUES (true) ON CONFLICT DO NOTHING`,
    );
    await closeDb();
  });

  test('concurrent first reads all succeed when the row is missing', async ({
    request,
  }) => {
    // The service caches the row for CACHE_TTL_MS (10s), and a warm cache never
    // reaches the database — so deleting the row and firing immediately would
    // be answered from memory and prove nothing. Waiting the window out is what
    // makes the next read genuinely a first read.
    test.setTimeout(60_000);

    await sql('TRUNCATE TABLE "lead_pipeline_settings"');
    await new Promise((resolve) => setTimeout(resolve, 11_000));

    const responses = await Promise.all(
      Array.from({ length: 6 }, () =>
        request.get('/admin/leads/settings', {
          headers: auth(admin.accessToken),
        }),
      ),
    );

    const statuses = responses.map((res) => res.status());
    expect(statuses.filter((status) => status !== 200)).toEqual([]);

    // Exactly one row afterwards — the unique index is the guarantee, so a fix
    // that swallowed the conflict without re-reading would still be wrong.
    const rows = await sql<{ count: string }>(
      'SELECT COUNT(*)::text AS count FROM "lead_pipeline_settings"',
    );
    expect(rows[0].count).toBe('1');
  });
});
