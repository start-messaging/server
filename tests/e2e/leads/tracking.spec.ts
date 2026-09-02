import { test, expect, APIRequestContext } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { resetDb, closeDb, sql } from '../helpers/db.js';
import { createAdmin, Customer } from '../helpers/actors.js';
import { LeadRow, eventsOf, leadRow, queueOutreach, seedLead } from './helpers.js';

/**
 * The public tracking endpoints: /t/o (pixel), /t/c (click), /t/u
 * (unsubscribe). No JWT anywhere — a mail client carries none — and no
 * response may differ between a real and an invented token, or the routes
 * become an oracle for guessing which tokens exist.
 *
 * The pixel and click handlers are fire-and-forget on the server (the
 * response must not wait on the database), so their row assertions poll.
 * Unsubscribe is awaited before the page renders, so its assertions do not.
 */

/** Where clicks land when the requested host is not ours (config default). */
const LINK_BASE_URL = 'https://startmessaging.com';

/** Long enough for a fire-and-forget write that is never coming to not come. */
const SETTLE_MS = 500;

test.describe('outreach tracking', () => {
  let admin: Customer;

  test.beforeEach(async ({ request }) => {
    await resetDb();
    admin = await createAdmin(request);
  });

  test.afterAll(async () => {
    await closeDb();
  });

  /**
   * A lead the send path has really been through, so the token under test is
   * the server-minted one an actual email would carry.
   */
  async function contactedLead(request: APIRequestContext): Promise<LeadRow> {
    const lead = await seedLead({
      contactEmails: [`owner@${randomUUID().slice(0, 8)}-track.in`],
    });
    const res = await queueOutreach(request, admin.accessToken, lead.id, {
      email: lead.contactEmails[0],
    });
    expect(res.status(), await res.text()).toBe(201);
    return leadRow(lead.id);
  }

  test('the pixel answers a gif and records the first open only', async ({
    request,
  }) => {
    const lead = await contactedLead(request);

    const first = await request.get(`/t/o/${lead.outreachToken}`);
    expect(first.status()).toBe(200);
    expect(first.headers()['content-type']).toBe('image/gif');

    // The handler is fire-and-forget; the row lands moments after the gif.
    await expect
      .poll(async () => (await leadRow(lead.id)).openedAt, { timeout: 5_000 })
      .not.toBeNull();
    const openedAt = (await leadRow(lead.id)).openedAt;

    // Apple MPP and Gmail's proxy prefetch pixels, so repeats are signal-free:
    // same gif back, no second row, openedAt keeps the first timestamp.
    const second = await request.get(`/t/o/${lead.outreachToken}`);
    expect(second.status()).toBe(200);
    await new Promise((r) => setTimeout(r, SETTLE_MS));

    const events = await eventsOf(lead.id);
    expect(events.filter((e) => e.type === 'opened').length).toBe(1);
    expect((await leadRow(lead.id)).openedAt).toBe(openedAt);
  });

  test('a click through an allowed host redirects there and is recorded', async ({
    request,
  }) => {
    const lead = await contactedLead(request);
    const target = `${LINK_BASE_URL}/?smref=${lead.id}`;

    // maxRedirects: 0 — the assertion is on the Location header itself, and
    // following it would try to reach the real marketing site.
    const res = await request.get(
      `/t/c/${lead.outreachToken}?u=${encodeURIComponent(target)}`,
      { maxRedirects: 0 },
    );
    expect(res.status()).toBe(302);
    expect(res.headers()['location']).toBe(target);

    // handleClick writes clickedAt BEFORE it inserts the clicked event row
    // (outreach.service.ts), so a poll on clickedAt can wake in the gap
    // between the two writes and read zero events — it did, once, in a full
    // run. Waiting on the event row, the later write, means clickedAt is
    // settled too by the time it is read.
    await expect
      .poll(
        async () =>
          (await eventsOf(lead.id)).filter((e) => e.type === 'clicked').length,
        { timeout: 5_000 },
      )
      .toBe(1);
    expect((await leadRow(lead.id)).clickedAt).not.toBeNull();
    const events = await eventsOf(lead.id);
    const clicked = events.filter((e) => e.type === 'clicked');
    expect(clicked.length).toBe(1);
    expect(clicked[0].payload).toEqual({ url: target });
    expect(clicked[0].provider).toBe('tracker');
  });

  test('a foreign host is never redirected to', async ({ request }) => {
    const lead = await contactedLead(request);

    // `u` is attacker-writable: anyone can mint /t/c/<token>?u=<anything>.
    // Forwarding it would make the tracker an open redirect on our domain.
    const res = await request.get(
      `/t/c/${lead.outreachToken}?u=${encodeURIComponent('https://evil.example/x')}`,
      { maxRedirects: 0 },
    );
    expect(res.status()).toBe(302);
    expect(res.headers()['location']).toBe(LINK_BASE_URL);

    // The event records where we actually sent them, not the attacker's URL.
    await expect
      .poll(
        async () =>
          (await eventsOf(lead.id)).filter((e) => e.type === 'clicked').length,
        { timeout: 5_000 },
      )
      .toBe(1);
    const [clicked] = (await eventsOf(lead.id)).filter(
      (e) => e.type === 'clicked',
    );
    expect(clicked.payload).toEqual({ url: LINK_BASE_URL });
  });

  test('an unknown pixel token gets the identical gif and writes nothing', async ({
    request,
  }) => {
    // The no-oracle property was pinned for /t/c and /t/u but never for the
    // pixel itself: byte-for-byte the same 200 image for a real token and an
    // invented one, with no row and no openedAt behind the invented one.
    const lead = await contactedLead(request);

    const real = await request.get(`/t/o/${lead.outreachToken}`);
    const invented = await request.get(`/t/o/${randomUUID()}`);

    expect(invented.status()).toBe(real.status());
    expect(invented.headers()['content-type']).toBe(
      real.headers()['content-type'],
    );
    expect(invented.headers()['cache-control']).toBe(
      real.headers()['cache-control'],
    );
    expect(invented.headers()['cache-control']).toBe('no-store, max-age=0');
    expect(Buffer.compare(await invented.body(), await real.body())).toBe(0);

    // The real token's open lands (fire-and-forget), the invented one leaves
    // nothing: exactly one opened event in the whole table, and no second
    // lead's openedAt was invented into existence.
    await expect
      .poll(async () => (await leadRow(lead.id)).openedAt, { timeout: 5_000 })
      .not.toBeNull();
    await new Promise((r) => setTimeout(r, SETTLE_MS));

    const [{ count }] = await sql<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM "lead_outreach_events" WHERE "type" = 'opened'`,
    );
    expect(count).toBe(1);
    const [{ opened }] = await sql<{ opened: number }>(
      `SELECT COUNT(*)::int AS opened FROM "leads" WHERE "openedAt" IS NOT NULL`,
    );
    expect(opened).toBe(1);
  });

  test('an unknown token still redirects and writes nothing', async ({
    request,
  }) => {
    const res = await request.get(`/t/c/${randomUUID()}`, { maxRedirects: 0 });
    expect(res.status(), 'no oracle: unknown tokens look identical').toBe(302);
    expect(res.headers()['location']).toBe(LINK_BASE_URL);

    await new Promise((r) => setTimeout(r, SETTLE_MS));
    const [{ count }] = await sql<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM "lead_outreach_events" WHERE "type" = 'clicked'`,
    );
    expect(count).toBe(0);
  });

  test('the unsubscribe page suppresses the address and flips the lead', async ({
    request,
  }) => {
    const lead = await contactedLead(request);

    const res = await request.get(`/t/u/${lead.outreachToken}`);
    expect(res.status()).toBe(200);
    expect(res.headers()['content-type']).toContain('text/html');
    expect(await res.text()).toContain('unsubscribed');

    // handleUnsubscribe is awaited before the page renders — no polling.
    const stored = await leadRow(lead.id);
    expect(stored.status).toBe('unsubscribed');

    const [suppression] = await sql<{ email: string; reason: string }>(
      `SELECT "email", "reason" FROM "outreach_suppressions"`,
    );
    expect(suppression).toEqual({
      email: lead.outreachEmail,
      reason: 'unsubscribed',
    });

    const events = await eventsOf(lead.id);
    expect(events.filter((e) => e.type === 'unsubscribed').length).toBe(1);
  });

  test('RFC 8058 one-click POST unsubscribes the same way', async ({
    request,
  }) => {
    const lead = await contactedLead(request);

    const res = await request.post(`/t/u/${lead.outreachToken}`);
    expect(res.status(), await res.text()).toBe(200);

    const stored = await leadRow(lead.id);
    expect(stored.status).toBe('unsubscribed');
    const [{ count }] = await sql<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM "outreach_suppressions" WHERE "email" = $1`,
      [lead.outreachEmail],
    );
    expect(count).toBe(1);
    expect(
      (await eventsOf(lead.id)).filter((e) => e.type === 'unsubscribed').length,
    ).toBe(1);
  });

  test('an unknown unsubscribe token gets the same page and writes nothing', async ({
    request,
  }) => {
    // The person clicked "unsubscribe"; the only acceptable answer is that it
    // worked — even when the token matches nothing.
    const res = await request.get(`/t/u/${randomUUID()}`);
    expect(res.status()).toBe(200);
    expect(await res.text()).toContain('unsubscribed');

    const [{ suppressions }] = await sql<{ suppressions: number }>(
      `SELECT COUNT(*)::int AS suppressions FROM "outreach_suppressions"`,
    );
    expect(suppressions).toBe(0);
    const [{ events }] = await sql<{ events: number }>(
      `SELECT COUNT(*)::int AS events FROM "lead_outreach_events"
        WHERE "type" = 'unsubscribed'`,
    );
    expect(events).toBe(0);
  });
});
