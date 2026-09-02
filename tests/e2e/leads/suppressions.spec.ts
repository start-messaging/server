import { test, expect, APIRequestContext } from '@playwright/test';
import { resetDb, closeDb, sql } from '../helpers/db.js';
import { createAdmin, payload, auth, Customer } from '../helpers/actors.js';
import { errorOf, paginationOf, queueOutreach, seedLead } from './helpers.js';

/**
 * The suppression list: the addresses cold outreach must never touch again.
 *
 * The list is only worth anything if the send path actually consults it, so
 * the last test here is the one that matters most: a queue-outreach against
 * a suppressed address is refused before anything is claimed or sent.
 */

test.describe('outreach suppressions', () => {
  let admin: Customer;

  test.beforeEach(async ({ request }) => {
    await resetDb();
    admin = await createAdmin(request);
  });

  test.afterAll(async () => {
    await closeDb();
  });

  const create = (request: APIRequestContext, data: Record<string, unknown>) =>
    request.post('/admin/leads/suppressions', {
      data,
      headers: auth(admin.accessToken),
    });

  test('creating one defaults the reason and lowercases the address', async ({
    request,
  }) => {
    const res = await create(request, { email: 'MiXeD@Example-Mail.IN' });
    // Plain @Post with no @HttpCode → Nest's default 201.
    expect(res.status(), await res.text()).toBe(201);
    const body = await payload<any>(res);
    expect(body.email).toBe('mixed@example-mail.in');
    expect(body.reason).toBe('manual');
    expect(body.notes).toBeNull();

    // The lowercasing must be in the row, not just the response — the send
    // path compares against the stored value.
    const [row] = await sql<{ email: string; reason: string }>(
      `SELECT "email", "reason" FROM "outreach_suppressions"`,
    );
    expect(row).toEqual({ email: 'mixed@example-mail.in', reason: 'manual' });
  });

  test('the same address twice is a 409, whatever its case', async ({
    request,
  }) => {
    const first = await create(request, { email: 'owner@dupe-mail.in' });
    expect(first.status(), await first.text()).toBe(201);

    // Different spelling, same address after lowercasing — the unique
    // constraint on the stored form is the arbiter.
    const second = await create(request, { email: 'OWNER@dupe-mail.in' });
    expect(second.status()).toBe(409);
    expect((await errorOf(second)).code).toBe('CONFLICT');

    const [{ count }] = await sql<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM "outreach_suppressions"`,
    );
    expect(count).toBe(1);
  });

  test('listing and searching by email substring', async ({ request }) => {
    for (const email of [
      'alpha@one-mail.in',
      'beta@two-mail.in',
      'gamma@two-mail.in',
    ]) {
      const res = await create(request, { email, reason: 'bounced' });
      expect(res.status(), await res.text()).toBe(201);
    }

    const all = await request.get('/admin/leads/suppressions', {
      headers: auth(admin.accessToken),
    });
    expect(all.status(), await all.text()).toBe(200);
    expect((await payload<unknown[]>(all)).length).toBe(3);
    expect((await paginationOf(all)).totalItems).toBe(3);

    const searched = await request.get(
      '/admin/leads/suppressions?search=two-mail',
      { headers: auth(admin.accessToken) },
    );
    const rows = await payload<Array<{ email: string }>>(searched);
    expect(rows.map((r) => r.email).sort()).toEqual([
      'beta@two-mail.in',
      'gamma@two-mail.in',
    ]);
  });

  test('removing one is a hard delete, and the second delete says so', async ({
    request,
  }) => {
    const created = await create(request, { email: 'gone@rm-mail.in' });
    const { id } = await payload<{ id: string }>(created);

    const removed = await request.delete(`/admin/leads/suppressions/${id}`, {
      headers: auth(admin.accessToken),
    });
    expect(removed.status(), await removed.text()).toBe(200);
    expect(await payload(removed)).toEqual({ removed: true });

    // Hard delete: no soft-deleted row may linger reading "never mail this".
    const [{ count }] = await sql<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM "outreach_suppressions"`,
    );
    expect(count).toBe(0);

    const again = await request.delete(`/admin/leads/suppressions/${id}`, {
      headers: auth(admin.accessToken),
    });
    expect(again.status()).toBe(404);
    expect((await errorOf(again)).code).toBe('NOT_FOUND');
  });

  test('queue-outreach against a suppressed address is refused untouched', async ({
    request,
  }) => {
    const email = 'prospect@suppressed-mail.in';
    const lead = await seedLead({ contactEmails: [email] });
    const res = await create(request, { email });
    expect(res.status(), await res.text()).toBe(201);

    // Case-shifted on purpose: the send path lowercases before checking, so
    // a mixed-case entry must not slip past the list.
    const refused = await queueOutreach(request, admin.accessToken, lead.id, {
      email: 'Prospect@Suppressed-Mail.IN',
    });
    expect(refused.status()).toBe(409);
    expect((await errorOf(refused)).code).toBe('LEAD_SUPPRESSED');

    // Refused before anything was claimed: no status change, no events.
    const [row] = await sql<{ status: string; outreachEmail: string | null }>(
      `SELECT "status", "outreachEmail" FROM "leads" WHERE "id" = $1`,
      [lead.id],
    );
    expect(row).toEqual({ status: 'new', outreachEmail: null });
    const [{ events }] = await sql<{ events: number }>(
      `SELECT COUNT(*)::int AS events FROM "lead_outreach_events" WHERE "leadId" = $1`,
      [lead.id],
    );
    expect(events).toBe(0);
  });
});
