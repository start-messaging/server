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
  paginationOf,
  seedLead,
} from './helpers.js';

/**
 * The admin read/update surface over the leads table: GET /admin/leads and
 * its filters, GET stats, GET :id with its event history, and PATCH :id.
 *
 * Every test seeds the same four-lead matrix, chosen so each filter splits
 * it differently: two Indian and two not (one of those null — the unknowns
 * must land with the non-Indian side), two with a contact and two without,
 * one lead per enrichment status, distinct scores for the sort assertions.
 */

async function seedMatrix() {
  const a = await seedLead({
    domain: 'alpha-blooms.in',
    status: 'new',
    enrichmentStatus: 'enriched',
    contactEmails: ['a@alpha-blooms.in'],
    isIndian: true,
    score: 5,
    qualificationScore: 9,
    siteTitle: 'Alpha Flower Boutique',
  });
  const b = await seedLead({
    domain: 'beta-kirana.co.in',
    status: 'contacted',
    enrichmentStatus: 'pending',
    isIndian: true,
    score: 3,
    qualificationScore: 4,
  });
  const c = await seedLead({
    domain: 'gamma-tools.dev',
    status: 'new',
    enrichmentStatus: 'no_contact',
    contactPhones: ['+15550001111'],
    isIndian: false,
    score: 0,
    qualificationScore: 2,
  });
  const d = await seedLead({
    domain: 'delta-freight.in',
    status: 'disqualified',
    enrichmentStatus: 'failed',
    isIndian: null,
    score: 1,
    qualificationScore: 0,
    siteTitle: 'Delta Freight Portal',
  });
  return { a, b, c, d };
}

async function listDomains(
  request: APIRequestContext,
  token: string,
  query: string,
): Promise<string[]> {
  const res = await request.get(`/admin/leads?${query}`, {
    headers: auth(token),
  });
  expect(res.status(), await res.text()).toBe(200);
  const rows = await payload<Array<{ domain: string }>>(res);
  return rows.map((r) => r.domain);
}

test.describe('admin leads listing', () => {
  let admin: Customer;

  test.beforeEach(async ({ request }) => {
    await resetDb();
    admin = await createAdmin(request);
  });

  test.afterAll(async () => {
    await closeDb();
  });

  test('each filter carves the matrix on its own axis', async ({ request }) => {
    await seedMatrix();
    const domains = (q: string) => listDomains(request, admin.accessToken, q);

    expect(await domains('status=contacted')).toEqual(['beta-kirana.co.in']);
    expect(await domains('enrichmentStatus=no_contact')).toEqual([
      'gamma-tools.dev',
    ]);

    // hasContact reads all three jsonb arrays — gamma qualifies on a phone
    // alone, which is what proves the check is not email-only.
    expect((await domains('hasContact=true')).sort()).toEqual([
      'alpha-blooms.in',
      'gamma-tools.dev',
    ]);
    expect((await domains('hasContact=false')).sort()).toEqual([
      'beta-kirana.co.in',
      'delta-freight.in',
    ]);

    // india=false is IS NOT TRUE: delta's null lands with the non-Indian
    // side rather than disappearing from both views.
    expect((await domains('india=true')).sort()).toEqual([
      'alpha-blooms.in',
      'beta-kirana.co.in',
    ]);
    expect((await domains('india=false')).sort()).toEqual([
      'delta-freight.in',
      'gamma-tools.dev',
    ]);

    // (No tld filter anymore — the column was dropped as derivable noise;
    // TLD questions are answered by searching the domain string.)

    // search hits domain and siteTitle, case-insensitively.
    expect(await domains('search=kirana')).toEqual(['beta-kirana.co.in']);
    expect(await domains('search=BOUTIQUE')).toEqual(['alpha-blooms.in']);
    expect(await domains('search=portal')).toEqual(['delta-freight.in']);
  });

  test('sorting and the pagination envelope', async ({ request }) => {
    await seedMatrix();
    const domains = (q: string) => listDomains(request, admin.accessToken, q);

    expect(await domains('sortBy=score&sortOrder=asc')).toEqual([
      'gamma-tools.dev', // 0
      'delta-freight.in', // 1
      'beta-kirana.co.in', // 3
      'alpha-blooms.in', // 5
    ]);
    expect(await domains('sortBy=qualificationScore&sortOrder=DESC')).toEqual([
      'alpha-blooms.in', // 9
      'beta-kirana.co.in', // 4
      'gamma-tools.dev', // 2
      'delta-freight.in', // 0
    ]);

    const page2 = await request.get('/admin/leads?limit=3&page=2', {
      headers: auth(admin.accessToken),
    });
    expect(page2.status(), await page2.text()).toBe(200);
    expect((await payload<unknown[]>(page2)).length).toBe(1);
    expect(await paginationOf(page2)).toEqual({
      page: 2,
      limit: 3,
      totalItems: 4,
      totalPages: 2,
      hasNextPage: false,
      hasPreviousPage: true,
    });
  });

  test('stats aggregate totals, breakdowns and recent runs', async ({
    request,
  }) => {
    await seedMatrix();
    // Runs are seeded directly — the ingest spec owns driving real ones; this
    // test is about how stats reads them back (last 7 by fileDate desc).
    await sql(
      `INSERT INTO "lead_ingest_runs"
         ("fileDate", "status", "totalDomains", "matchedDomains", "insertedDomains", "finishedAt")
       VALUES ('2026-01-05', 'completed', 6, 3, 2, now()),
              ('2026-01-04', 'failed', 0, 0, 0, now())`,
    );

    const res = await request.get('/admin/leads/stats', {
      headers: auth(admin.accessToken),
    });
    expect(res.status(), await res.text()).toBe(200);
    const stats = await payload<any>(res);

    expect(stats.totals).toEqual({ all: 4, withContact: 2, india: 2 });
    // Statuses with zero rows are absent, not zero — the exact-object
    // comparison pins that.
    expect(stats.byStatus).toEqual({ new: 2, contacted: 1, disqualified: 1 });
    expect(stats.byEnrichment).toEqual({
      enriched: 1,
      pending: 1,
      no_contact: 1,
      failed: 1,
    });
    // The tier-0 tag breakdown: the matrix is seeded unprobed, so all four
    // sit in 'unknown' — statuses with zero rows stay absent, as above.
    expect(stats.byLiveness).toEqual({ unknown: 4 });

    expect(stats.recentRuns.length).toBe(2);
    expect(stats.recentRuns[0].fileDate).toBe('2026-01-05');
    expect(stats.recentRuns[1].fileDate).toBe('2026-01-04');
  });

  test('one lead comes back with its events, newest first', async ({
    request,
  }) => {
    const { a } = await seedMatrix();
    await sql(
      `INSERT INTO "lead_outreach_events" ("leadId", "type", "provider", "occurredAt")
       VALUES ($1, 'queued', 'console', now() - interval '2 minutes'),
              ($1, 'sent', 'console', now() - interval '1 minute')`,
      [a.id],
    );

    const res = await request.get(`/admin/leads/${a.id}`, {
      headers: auth(admin.accessToken),
    });
    expect(res.status(), await res.text()).toBe(200);
    const body = await payload<any>(res);
    expect(body.domain).toBe('alpha-blooms.in');
    expect(body.events.map((e: any) => e.type)).toEqual(['sent', 'queued']);

    const missing = await request.get(`/admin/leads/${ABSENT_UUID}`, {
      headers: auth(admin.accessToken),
    });
    expect(missing.status()).toBe(404);
    expect((await errorOf(missing)).code).toBe('NOT_FOUND');
  });

  test('PATCH accepts the manual statuses and rejects the pipeline-owned ones', async ({
    request,
  }) => {
    const { a } = await seedMatrix();
    const patch = (data: Record<string, unknown>) =>
      request.patch(`/admin/leads/${a.id}`, {
        data,
        headers: auth(admin.accessToken),
      });

    // The four statuses an admin may set by hand (MANUAL_LEAD_STATUSES).
    for (const status of ['replied', 'converted', 'disqualified', 'new']) {
      const res = await patch({ status });
      expect(res.status(), `PATCH status=${status}: ${await res.text()}`).toBe(
        200,
      );
      expect((await leadRow(a.id)).status).toBe(status);
    }

    const updated = await patch({
      notes: 'spoke to the owner',
      outreachEmail: 'Sales@Alpha-Blooms.IN',
    });
    expect(updated.status(), await updated.text()).toBe(200);
    const body = await payload<any>(updated);
    expect(body.notes).toBe('spoke to the owner');
    expect(body.outreachEmail, 'stored lowercased').toBe(
      'sales@alpha-blooms.in',
    );
    expect((await leadRow(a.id)).outreachEmail).toBe('sales@alpha-blooms.in');

    // 'contacted' belongs to the send path; writing it by hand would forge
    // delivery history.
    const forged = await patch({ status: 'contacted' });
    expect(forged.status()).toBe(400);
    expect((await errorOf(forged)).code).toBe('VALIDATION_ERROR');
    expect((await leadRow(a.id)).status).toBe('new');
  });

  test('teamRating: PATCH sets and clears it, out-of-range is refused, sort puts unrated last', async ({
    request,
  }) => {
    // The human 1–5 judgement layered on top of the machine signals — the
    // team's "solid" rating the fit score deliberately is not.
    const { a, b, c, d } = await seedMatrix();
    const patch = (id: string, data: Record<string, unknown>) =>
      request.patch(`/admin/leads/${id}`, {
        data,
        headers: auth(admin.accessToken),
      });

    for (const rating of [1, 2, 3, 4, 5]) {
      const res = await patch(a.id, { teamRating: rating });
      expect(res.status(), `teamRating=${rating}: ${await res.text()}`).toBe(
        200,
      );
    }
    const rated = await patch(b.id, { teamRating: 2 });
    expect(rated.status(), await rated.text()).toBe(200);

    // Out-of-range and non-integer values die in the DTO, before the CHECK
    // constraint would refuse them anyway.
    for (const bad of [0, 6, 3.5, 'three']) {
      const res = await patch(a.id, { teamRating: bad });
      expect(res.status(), `teamRating=${String(bad)} must 400`).toBe(400);
      expect((await errorOf(res)).code).toBe('VALIDATION_ERROR');
    }

    // a=5, b=2, c/d unrated. Desc puts the unrated NULLs LAST — a mostly-
    // NULL column sorted naively would bury every rated lead.
    const desc = await request.get(
      '/admin/leads?sortBy=teamRating&sortOrder=desc',
      { headers: auth(admin.accessToken) },
    );
    expect(desc.status(), await desc.text()).toBe(200);
    const descDomains = (await payload<Array<{ domain: string }>>(desc)).map(
      (r) => r.domain,
    );
    expect(descDomains.slice(0, 2)).toEqual([
      'alpha-blooms.in',
      'beta-kirana.co.in',
    ]);
    // The two unrated leads follow, in whatever tie order the db picks.
    expect(descDomains.slice(2).sort()).toEqual([
      'delta-freight.in',
      'gamma-tools.dev',
    ]);

    // Present-with-null clears the rating back to unrated.
    const cleared = await patch(a.id, { teamRating: null });
    expect(cleared.status(), await cleared.text()).toBe(200);
    expect((await leadRow(a.id)).teamRating).toBeNull();
    expect((await leadRow(b.id)).teamRating).toBe(2);
  });

  test('the listing surface is admin-only', async ({ request }) => {
    // (This test also carried the tld-filter validation until the column —
    // and with it the filter — was dropped as derivable noise.)
    await seedMatrix();

    const customer = await createCustomer(request);
    const asCustomer = await request.get('/admin/leads', {
      headers: auth(customer.accessToken),
    });
    expect(asCustomer.status()).toBe(403);
    expect((await errorOf(asCustomer)).code).toBe('FORBIDDEN');

    const anonymous = await request.get('/admin/leads');
    expect(anonymous.status()).toBe(401);
    expect((await errorOf(anonymous)).code).toBe('UNAUTHORIZED');
  });
});
