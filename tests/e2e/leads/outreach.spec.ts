import { test, expect } from '@playwright/test';
import { resetDb, closeDb, sql } from '../helpers/db.js';
import {
  auth,
  createAdmin,
  createCustomer,
  payload,
  Customer,
} from '../helpers/actors.js';
import {
  ABSENT_UUID,
  LeadRow,
  OUTREACH_DAILY_CAP,
  errorOf,
  eventsOf,
  leadRow,
  queueOutreach,
  seedLead,
} from './helpers.js';

/**
 * POST /admin/leads/:id/queue-outreach — the one endpoint that sends email
 * to a stranger, and therefore the one with the most refusals to pin.
 *
 * OUTREACH_CONSOLE_PROVIDER makes the send synchronous and free: the
 * response arrives after the whole claim → send → record sequence, so a 201
 * here means the lead is already 'contacted', not merely queued.
 */

test.describe('queue outreach', () => {
  let admin: Customer;

  test.beforeEach(async ({ request }) => {
    await resetDb();
    admin = await createAdmin(request);
  });

  test.afterAll(async () => {
    await closeDb();
  });

  test('a send claims the lead, mails it and records both events', async ({
    request,
  }) => {
    const lead = await seedLead({ contactEmails: ['owner@queue-mail.in'] });

    // Mixed case in, lowercase stored — same rule as the suppression list.
    const res = await queueOutreach(request, admin.accessToken, lead.id, {
      email: 'Owner@Queue-Mail.IN',
    });
    // Plain @Post with no @HttpCode → Nest's default 201.
    expect(res.status(), await res.text()).toBe(201);
    const body = await payload<any>(res);

    // 'contacted', not 'queued': the console provider already sent.
    expect(body.status).toBe('contacted');
    expect(body.outreachEmail).toBe('owner@queue-mail.in');
    expect(body.outreachProviderRef).toBe('console');
    expect(body.queuedAt).not.toBeNull();
    expect(body.contactedAt).not.toBeNull();

    const stored = await leadRow(lead.id);
    expect(stored.status).toBe('contacted');
    expect(stored.outreachToken, 'the tracking token is minted on claim')
      .not.toBeNull();
    expect(stored.contactedAt).not.toBeNull();

    const events = await eventsOf(lead.id);
    expect(events.map((e) => e.type)).toEqual(['queued', 'sent']);
    expect(events.map((e) => e.provider)).toEqual(['console', 'console']);
    expect(events[0].payload).toEqual({ email: 'owner@queue-mail.in' });
    expect(events[1].payload).toEqual({
      email: 'owner@queue-mail.in',
      ref: 'console',
    });
  });

  test('a contacted lead cannot be queued again', async ({ request }) => {
    const lead = await seedLead({ contactEmails: ['owner@requeue-mail.in'] });
    const first = await queueOutreach(request, admin.accessToken, lead.id, {
      email: 'owner@requeue-mail.in',
    });
    expect(first.status(), await first.text()).toBe(201);

    const second = await queueOutreach(request, admin.accessToken, lead.id, {
      email: 'owner@requeue-mail.in',
    });
    expect(second.status()).toBe(409);
    expect((await errorOf(second)).code).toBe('LEAD_ALREADY_QUEUED');

    // Exactly one send happened.
    const events = await eventsOf(lead.id);
    expect(events.map((e) => e.type)).toEqual(['queued', 'sent']);
  });

  test('a custom subject and body are accepted', async ({ request }) => {
    const lead = await seedLead({ contactEmails: ['owner@custom-mail.in'] });
    const res = await queueOutreach(request, admin.accessToken, lead.id, {
      email: 'owner@custom-mail.in',
      subject: 'A note about your new domain',
      bodyHtml: '<p>Hand-written opener.</p>',
    });
    expect(res.status(), await res.text()).toBe(201);
    expect((await payload<any>(res)).status).toBe('contacted');
  });

  test('a malformed address is refused before anything happens', async ({
    request,
  }) => {
    const lead = await seedLead({ contactEmails: ['owner@valid-mail.in'] });
    const res = await queueOutreach(request, admin.accessToken, lead.id, {
      email: 'not-an-address',
    });
    expect(res.status()).toBe(400);
    expect((await errorOf(res)).code).toBe('VALIDATION_ERROR');

    const stored = await leadRow(lead.id);
    expect(stored.status).toBe('new');
    expect(await eventsOf(lead.id)).toEqual([]);
  });

  test('the daily cap refuses the send after it, not the ones before', async ({
    request,
  }) => {
    // resetDb truncated lead_outreach_events, so the IST-day count starts at
    // zero and OUTREACH_DAILY_CAP=5 makes this exact: five sends land, the
    // sixth is refused.
    // Typed explicitly: bare `[]` under this tsconfig infers `never[]`, which
    // fails `npx tsc --noEmit` even though Playwright runs the file happily.
    const leads: LeadRow[] = [];
    for (let i = 0; i < OUTREACH_DAILY_CAP + 1; i += 1) {
      leads.push(await seedLead({ contactEmails: [`owner@cap-${i}-mail.in`] }));
    }

    for (let i = 0; i < OUTREACH_DAILY_CAP; i += 1) {
      const res = await queueOutreach(request, admin.accessToken, leads[i].id, {
        email: `owner@cap-${i}-mail.in`,
      });
      expect(res.status(), `send ${i + 1}: ${await res.text()}`).toBe(201);
    }

    const sixth = await queueOutreach(
      request,
      admin.accessToken,
      leads[OUTREACH_DAILY_CAP].id,
      { email: `owner@cap-${OUTREACH_DAILY_CAP}-mail.in` },
    );
    expect(sixth.status()).toBe(429);
    expect((await errorOf(sixth)).code).toBe('OUTREACH_DAILY_CAP_REACHED');

    // Refused before the claim: the sixth lead is still available tomorrow.
    const stored = await leadRow(leads[OUTREACH_DAILY_CAP].id);
    expect(stored.status).toBe('new');
    expect(await eventsOf(leads[OUTREACH_DAILY_CAP].id)).toEqual([]);

    const [{ sent }] = await sql<{ sent: number }>(
      `SELECT COUNT(*)::int AS sent FROM "lead_outreach_events" WHERE "type" = 'sent'`,
    );
    expect(sent).toBe(OUTREACH_DAILY_CAP);
  });

  test('an unknown lead is a NOT_FOUND envelope', async ({ request }) => {
    const res = await queueOutreach(request, admin.accessToken, ABSENT_UUID, {
      email: 'owner@nowhere-mail.in',
    });
    expect(res.status()).toBe(404);
    expect((await errorOf(res)).code).toBe('NOT_FOUND');
  });

  test('two simultaneous sends for one lead yield one email, one winner and one 409', async ({
    request,
  }) => {
    // The service's central concurrency claim (outreach.service.ts:91-94,
    // 138-153): the claim is a single conditional UPDATE whose WHERE is the
    // arbiter, so two admins clicking at once must produce exactly one send.
    // This is the endpoint that emails strangers — a double send is the
    // costly failure — and no parallel-request test existed anywhere in
    // leads/ before this one.
    const lead = await seedLead({ contactEmails: ['owner@race-mail.in'] });

    const [a, b] = await Promise.all([
      queueOutreach(request, admin.accessToken, lead.id, {
        email: 'owner@race-mail.in',
      }),
      queueOutreach(request, admin.accessToken, lead.id, {
        email: 'owner@race-mail.in',
      }),
    ]);

    const statuses = [a.status(), b.status()].sort();
    expect(statuses, `${await a.text()} / ${await b.text()}`).toEqual([
      201, 409,
    ]);
    const loser = a.status() === 409 ? a : b;
    expect((await errorOf(loser)).code).toBe('LEAD_ALREADY_QUEUED');

    // Exactly one queued/sent pair — the loser's refusal recorded nothing.
    const events = await eventsOf(lead.id);
    expect(events.map((e) => e.type)).toEqual(['queued', 'sent']);
    const [{ sent }] = await sql<{ sent: number }>(
      `SELECT COUNT(*)::int AS sent FROM "lead_outreach_events" WHERE "type" = 'sent'`,
    );
    expect(sent, 'the race sent more than one email').toBe(1);

    const stored = await leadRow(lead.id);
    expect(stored.status).toBe('contacted');
    expect(stored.outreachToken).not.toBeNull();
  });

  test('only an admin session may queue outreach', async ({ request }) => {
    // The class-level guard is pinned on sibling routes; this one route sends
    // email to a stranger, so it earns its own 401/403 pair with proof the
    // refusals sent nothing.
    const lead = await seedLead({ contactEmails: ['owner@guard-mail.in'] });

    const anonymous = await request.post(
      `/admin/leads/${lead.id}/queue-outreach`,
      { data: { email: 'owner@guard-mail.in' } },
    );
    expect(anonymous.status()).toBe(401);
    expect((await errorOf(anonymous)).code).toBe('UNAUTHORIZED');

    const customer = await createCustomer(request);
    const asCustomer = await request.post(
      `/admin/leads/${lead.id}/queue-outreach`,
      {
        data: { email: 'owner@guard-mail.in' },
        headers: auth(customer.accessToken),
      },
    );
    expect(asCustomer.status()).toBe(403);
    expect((await errorOf(asCustomer)).code).toBe('FORBIDDEN');

    const stored = await leadRow(lead.id);
    expect(stored.status).toBe('new');
    expect(await eventsOf(lead.id)).toEqual([]);
  });
});
