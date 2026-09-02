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
  ABSENT_UUID,
  errorOf,
  leadRow,
  seedLead,
  sitePageHtml,
  startFixtureServer,
} from './helpers.js';

/**
 * Tier-0 liveness: the manual probe endpoint (the panel's "check site"
 * button), the hourly sweep with its re-probe backoff, the live-only gate on
 * the enrichment sweep, and delisting (status=disqualified) stopping every
 * sweep.
 *
 * Two branches deliberately have NO e2e coverage and are unit-tested in
 * parked-detector.spec.ts / documented in the prober instead: the
 * parking-nameserver probe path and the 'no_dns' classification — both need
 * real DNS, and the fixture domains are unregistered by design (their fetches
 * go to 127.0.0.1 via the URL template, so DNS never decides anything here).
 */

const UP_SITE = 'up-blooms.e2e-fixture.in';
const DOWN_SITE = 'down-blooms.e2e-fixture.in';
const REPROBE_SITE = 'reprobe-blooms.e2e-fixture.in';
const CRAWLABLE = 'crawlable-blooms.e2e-fixture.in';
const DELISTED = 'delisted-blooms.e2e-fixture.in';

function probe(request: APIRequestContext, token: string, id: string) {
  return request.post(`/admin/leads/${id}/probe`, { headers: auth(token) });
}

function runSweep(
  request: APIRequestContext,
  token: string,
  which: 'liveness' | 'enrich',
) {
  return request.post(`/admin/leads/${which}-sweep/run`, {
    headers: auth(token),
  });
}

test.describe('lead liveness', () => {
  let fixture: { close(): Promise<void> };
  let admin: Customer;

  test.beforeAll(async () => {
    fixture = await startFixtureServer({
      [`/site/${UP_SITE}`]: { body: sitePageHtml({ domain: UP_SITE }) },
      [`/site/${DOWN_SITE}`]: {
        status: 500,
        body: 'fixture: deliberate server error',
      },
      [`/site/${REPROBE_SITE}`]: {
        body: sitePageHtml({ domain: REPROBE_SITE }),
      },
      [`/site/${CRAWLABLE}`]: {
        body: sitePageHtml({
          domain: CRAWLABLE,
          email: 'owner@crawlable-mail.in',
        }),
      },
      [`/site/${DELISTED}`]: {
        body: sitePageHtml({
          domain: DELISTED,
          email: 'owner@delisted-mail.in',
        }),
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

  test('the manual probe tags a serving site live, with the reason and clock', async ({
    request,
  }) => {
    const lead = await seedLead({ domain: UP_SITE });
    expect(lead.liveness).toBe('unknown');

    const res = await probe(request, admin.accessToken, lead.id);
    expect(res.status(), await res.text()).toBe(201);
    const body = await payload<any>(res);

    expect(body.liveness).toBe('live');
    expect(body.livenessDetail).toBe('ok');
    expect(body.livenessCheckedAt).not.toBeNull();
    // The probe reads headers only — it must not have crawled anything.
    expect(body.enrichmentStatus).toBe('pending');
    expect(body.contactEmails).toEqual([]);
  });

  test('a site that answers with an error is inactive, named as such', async ({
    request,
  }) => {
    const lead = await seedLead({ domain: DOWN_SITE });

    const res = await probe(request, admin.accessToken, lead.id);
    expect(res.status(), await res.text()).toBe(201);
    const body = await payload<any>(res);

    // Not a failure of the probe — "nothing to crawl here today" IS the
    // result, and the detail tells the team why the tag says inactive.
    expect(body.liveness).toBe('inactive');
    expect(body.livenessDetail).toBe('http_500');
    expect(body.livenessCheckedAt).not.toBeNull();
  });

  test('probe: unknown id is NOT_FOUND, and the surface is admin-only', async ({
    request,
  }) => {
    const missing = await probe(request, admin.accessToken, ABSENT_UUID);
    expect(missing.status()).toBe(404);
    expect((await errorOf(missing)).code).toBe('NOT_FOUND');

    const lead = await seedLead({ domain: UP_SITE });
    const customer = await createCustomer(request);
    const asCustomer = await probe(request, customer.accessToken, lead.id);
    expect(asCustomer.status()).toBe(403);
    expect((await errorOf(asCustomer)).code).toBe('FORBIDDEN');
  });

  test('the sweep probes unknowns and due re-probes, and honours the backoff', async ({
    request,
  }) => {
    const today = new Date().toISOString().slice(0, 10);
    // Never probed → always due.
    const unknown = await seedLead({ domain: UP_SITE, registeredOn: today });
    // Inactive, young, last checked 2 days ago → due (daily backoff), and
    // the fixture serves a page now — "not live today does not mean not
    // live in two days" is exactly this row.
    const dueAgain = await seedLead({
      domain: REPROBE_SITE,
      liveness: 'inactive',
      registeredOn: today,
    });
    await sql(
      `UPDATE "leads" SET "livenessCheckedAt" = now() - interval '2 days',
              "livenessDetail" = 'http_500' WHERE "id" = $1`,
      [dueAgain.id],
    );
    // Inactive but checked an hour ago → not due yet; must be untouched.
    const tooSoon = await seedLead({
      domain: DOWN_SITE,
      liveness: 'inactive',
      registeredOn: today,
    });
    await sql(
      `UPDATE "leads" SET "livenessCheckedAt" = now() - interval '1 hour'
        WHERE "id" = $1`,
      [tooSoon.id],
    );
    // Inactive, 100 days old, checked 8 days ago → on the MONTHLY arm of
    // the backoff by age, so 8 days is not due either.
    const oldDomain = await seedLead({
      domain: DELISTED, // any routed fixture; it must not be fetched anyway
      liveness: 'inactive',
      registeredOn: '2026-05-01',
    });
    await sql(
      `UPDATE "leads" SET "livenessCheckedAt" = now() - interval '8 days'
        WHERE "id" = $1`,
      [oldDomain.id],
    );

    const res = await runSweep(request, admin.accessToken, 'liveness');
    expect(res.status(), await res.text()).toBe(201);
    expect(await payload(res)).toEqual({ enqueued: true });

    await expect
      .poll(async () => (await leadRow(unknown.id)).liveness, {
        timeout: 30_000,
      })
      .toBe('live');
    await expect
      .poll(async () => (await leadRow(dueAgain.id)).liveness, {
        timeout: 30_000,
      })
      .toBe('live');
    expect((await leadRow(dueAgain.id)).livenessDetail).toBe('ok');

    // The not-due rows kept their clocks — the sweep never claimed them.
    const soon = await leadRow(tooSoon.id);
    expect(soon.liveness).toBe('inactive');
    const old = await leadRow(oldDomain.id);
    expect(old.liveness).toBe('inactive');
  });

  test('the enrich sweep claims live leads only', async ({ request }) => {
    const live = await seedLead({ domain: CRAWLABLE, liveness: 'live' });
    // Same crawlable fixture, but the prober has not passed it yet.
    const unprobed = await seedLead({
      domain: UP_SITE,
      liveness: 'unknown',
    });

    const res = await runSweep(request, admin.accessToken, 'enrich');
    expect(res.status(), await res.text()).toBe(201);

    await expect
      .poll(async () => (await leadRow(live.id)).enrichmentStatus, {
        timeout: 30_000,
      })
      .toBe('enriched');
    expect((await leadRow(live.id)).contactEmails).toEqual([
      'owner@crawlable-mail.in',
    ]);

    // The unprobed lead was deferred, not crawled: still pending, zero
    // attempts. Deferred ≠ dropped — its probe comes first by design.
    const skipped = await leadRow(unprobed.id);
    expect(skipped.enrichmentStatus).toBe('pending');
    expect(skipped.enrichmentAttempts).toBe(0);
  });

  test('delisting (status=disqualified) stops both sweeps; re-listing resumes', async ({
    request,
  }) => {
    // The delist button's API: PATCH status=disqualified — already a manual
    // status, now honoured by every sweep claim.
    const delisted = await seedLead({ domain: DELISTED, liveness: 'live' });
    const control = await seedLead({ domain: CRAWLABLE, liveness: 'live' });

    const patch = await request.patch(`/admin/leads/${delisted.id}`, {
      data: { status: 'disqualified' },
      headers: auth(admin.accessToken),
    });
    expect(patch.status(), await patch.text()).toBe(200);

    await runSweep(request, admin.accessToken, 'liveness');
    await runSweep(request, admin.accessToken, 'enrich');

    // The control lead proves both sweeps actually ran to completion…
    await expect
      .poll(async () => (await leadRow(control.id)).enrichmentStatus, {
        timeout: 30_000,
      })
      .toBe('enriched');

    // …and the delisted one was skipped by both: no probe, no crawl.
    const skipped = await leadRow(delisted.id);
    expect(skipped.livenessCheckedAt).toBeNull();
    expect(skipped.enrichmentStatus).toBe('pending');
    expect(skipped.enrichmentAttempts).toBe(0);

    // Reversible: back to 'new' re-lists it, and the next sweep picks it up.
    const relist = await request.patch(`/admin/leads/${delisted.id}`, {
      data: { status: 'new' },
      headers: auth(admin.accessToken),
    });
    expect(relist.status(), await relist.text()).toBe(200);
    await runSweep(request, admin.accessToken, 'enrich');
    await expect
      .poll(async () => (await leadRow(delisted.id)).enrichmentStatus, {
        timeout: 30_000,
      })
      .toBe('enriched');
  });

  test('the list filters by liveness and stats break it down', async ({
    request,
  }) => {
    await seedLead({ domain: UP_SITE, liveness: 'live' });
    await seedLead({ domain: DOWN_SITE, liveness: 'inactive' });
    await seedLead({ domain: REPROBE_SITE }); // unknown

    const listed = await request.get('/admin/leads?liveness=inactive', {
      headers: auth(admin.accessToken),
    });
    expect(listed.status(), await listed.text()).toBe(200);
    const rows = await payload<Array<{ domain: string }>>(listed);
    expect(rows.map((r) => r.domain)).toEqual([DOWN_SITE]);

    const stats = await request.get('/admin/leads/stats', {
      headers: auth(admin.accessToken),
    });
    expect(stats.status(), await stats.text()).toBe(200);
    const body = await payload<any>(stats);
    expect(body.byLiveness).toEqual({ live: 1, inactive: 1, unknown: 1 });
  });
});
