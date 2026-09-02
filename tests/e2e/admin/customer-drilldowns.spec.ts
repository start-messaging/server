import { test, expect } from '@playwright/test';
import { resetDb, closeDb, sql } from '../helpers/db.js';
import {
  createAdmin,
  createCustomer,
  seedCustomer,
  onboardCustomer,
  seedDeliveredMessage,
  auth,
  payload,
  Customer,
} from '../helpers/actors.js';
import { seedLedger } from '../helpers/wallet.js';
import { GHOST_ID, errorOf, meta } from './users-kyc-helpers.js';

/**
 * The admin customer drilldowns, at their seams.
 *
 * admin/overview.spec.ts establishes that these routes work and that the role check
 * holds. This file is about what happens either side of that: the id that
 * belongs to nobody, and the value one type away from the one the DTO expects.
 */

test.describe('admin customer drilldowns', () => {
  let admin: Customer;
  let customer: Customer;

  test.beforeEach(async ({ request }) => {
    await resetDb();
    admin = await createAdmin(request);
    customer = await createCustomer(request);
    await onboardCustomer(customer.id);
  });

  test.afterAll(async () => {
    await closeDb();
  });

  test('the overview reports the welcome credit as an exact number', async ({
    request,
  }) => {
    const res = await request.get(`/admin/users/${customer.id}/overview`, {
      headers: auth(admin.accessToken),
    });
    expect(res.status(), await res.text()).toBe(200);

    const body = await payload<{
      wallet: { balance: number; currency: string };
      messages: { totalMessages: number; totalSpent: number };
      apiKeyCount: number;
    }>(res);

    // Registration credits ₹10. Numeric columns arrive from Postgres as
    // strings, and "10.0000" + 5 is "10.00005" — the handler coerces, and
    // this is what proves it still does.
    expect(typeof body.wallet.balance).toBe('number');
    expect(body.wallet.balance).toBe(10);
    expect(body.wallet.currency).toBe('INR');
    expect(body.messages.totalMessages).toBe(0);
    expect(body.messages.totalSpent).toBe(0);
    expect(body.apiKeyCount).toBe(0);
  });

  test('an overview never creates a second wallet for a user', async ({
    request,
  }) => {
    // A seeded user has no wallet row at all — getWallet creates one on read,
    // which findWalletId's own comment says a read must not do. Whether or
    // not that stays, two reads must never leave two wallets behind.
    const seeded = await seedCustomer();

    for (const attempt of [1, 2]) {
      const res = await request.get(`/admin/users/${seeded.id}/overview`, {
        headers: auth(admin.accessToken),
      });
      expect(res.status(), `attempt ${attempt}: ${await res.text()}`).toBe(200);
      const body = await payload<{ wallet: { balance: number } }>(res);
      expect(body.wallet.balance).toBe(0);
    }

    const [{ count }] = await sql<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM "wallets" WHERE "userId" = $1`,
      [seeded.id],
    );
    expect(count).toBeLessThanOrEqual(1);
  });

  test('an overview of a user that does not exist never fabricates a wallet', async ({
    request,
  }) => {
    const res = await request.get(`/admin/users/${GHOST_ID}/overview`, {
      headers: auth(admin.accessToken),
    });

    // The hard invariant: a read for an id that owns nothing must not write a
    // row against it. Today the write is attempted and the users foreign key
    // stops it, which surfaces as a 500 — see the report; the correct answer
    // is a 404.
    const [{ count }] = await sql<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM "wallets" WHERE "userId" = $1`,
      [GHOST_ID],
    );
    expect(count).toBe(0);
    expect(
      res.ok(),
      'an overview was served for a user that does not exist',
    ).toBeFalsy();
  });

  test('the other drilldowns answer empty for an unknown user rather than failing', async ({
    request,
  }) => {
    for (const path of [
      `/admin/users/${GHOST_ID}/messages`,
      `/admin/users/${GHOST_ID}/transactions`,
      `/admin/users/${GHOST_ID}/api-keys`,
    ]) {
      const res = await request.get(path, {
        headers: auth(admin.accessToken),
      });
      expect(res.status(), `${path}: ${await res.text()}`).toBe(200);
      expect(await payload<unknown[]>(res)).toHaveLength(0);
      expect((await meta(res)).totalItems).toBe(0);
    }
  });

  test('a transaction list is scoped to one wallet and its filters really filter', async ({
    request,
  }) => {
    const other = await createCustomer(request);

    const res = await request.get(`/admin/users/${customer.id}/transactions`, {
      headers: auth(admin.accessToken),
    });
    expect(res.status(), await res.text()).toBe(200);

    const rows = await payload<
      {
        type: string;
        amount: string;
        balanceAfter: string;
        referenceType: string;
      }[]
    >(res);
    // Exactly one movement so far: the ₹10 welcome credit, and no trace of
    // the other customer's identical one.
    expect(rows).toHaveLength(1);
    expect(rows[0].type).toBe('credit');
    expect(Number(rows[0].amount)).toBe(10);
    expect(Number(rows[0].balanceAfter)).toBe(10);
    expect(rows[0].referenceType).toBe('registration');

    const otherRes = await request.get(
      `/admin/users/${other.id}/transactions`,
      {
        headers: auth(admin.accessToken),
      },
    );
    expect(await payload<unknown[]>(otherRes)).toHaveLength(1);

    // A filter that is accepted and then dropped returns every row and looks
    // like a match, which is the failure mode queryTransactions was rewritten
    // to prevent.
    const wrongReference = await request.get(
      `/admin/users/${customer.id}/transactions?referenceType=payment`,
      { headers: auth(admin.accessToken) },
    );
    expect(await payload<unknown[]>(wrongReference)).toHaveLength(0);

    const wrongType = await request.get(
      `/admin/users/${customer.id}/transactions?type=debit`,
      { headers: auth(admin.accessToken) },
    );
    expect(await payload<unknown[]>(wrongType)).toHaveLength(0);

    const badType = await request.get(
      `/admin/users/${customer.id}/transactions?type=withdrawal`,
      { headers: auth(admin.accessToken) },
    );
    expect(badType.status(), await badType.text()).toBe(400);
    expect((await errorOf(badType)).code).toBe('VALIDATION_ERROR');
  });

  test('the api-key list is scoped to the user and never returns a usable key', async ({
    request,
  }) => {
    const other = await createCustomer(request);
    await onboardCustomer(other.id);

    const created = await request.post('/api-keys', {
      data: { label: 'production' },
      headers: auth(customer.accessToken),
    });
    expect(created.status(), await created.text()).toBe(201);
    const mine = await payload<{ id: string; key: string }>(created);

    const theirs = await request.post('/api-keys', {
      data: { label: 'not yours' },
      headers: auth(other.accessToken),
    });
    expect(theirs.ok(), await theirs.text()).toBeTruthy();

    const res = await request.get(`/admin/users/${customer.id}/api-keys`, {
      headers: auth(admin.accessToken),
    });
    expect(res.status(), await res.text()).toBe(200);

    const rows =
      await payload<{ id: string; userId: string; label: string }[]>(res);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(mine.id);
    expect(rows[0].userId).toBe(customer.id);

    // The secret is shown once, at creation, and never again. A list that
    // hands back something that authenticates is a full account takeover from
    // a read-only admin screen.
    const text = await res.text();
    expect(text).not.toContain(mine.key);
    expect(text, 'a full API key appeared in the admin list').not.toMatch(
      /sm_live_[0-9a-f]{40}/,
    );

    // Deleting a key is a soft delete; the admin view must respect it rather
    // than resurrect keys the customer believes are gone.
    const deleted = await request.delete(`/api-keys/${mine.id}`, {
      headers: auth(customer.accessToken),
    });
    expect(deleted.ok(), await deleted.text()).toBeTruthy();

    const after = await request.get(`/admin/users/${customer.id}/api-keys`, {
      headers: auth(admin.accessToken),
    });
    expect(await payload<unknown[]>(after)).toHaveLength(0);
  });

  test('platform-wide message search crosses tenants without leaking the owner credentials', async ({
    request,
  }) => {
    const other = await createCustomer(request);
    await onboardCustomer(other.id);
    await seedDeliveredMessage(customer.id, { costAmount: 0.25 });
    await seedDeliveredMessage(other.id, { costAmount: 0.25 });

    // This route exists to answer "what happened to this number?", so it is
    // the one admin read that deliberately crosses the customer boundary.
    const all = await request.get('/admin/messages', {
      headers: auth(admin.accessToken),
    });
    expect(all.status(), await all.text()).toBe(200);
    const rows =
      await payload<{ userId: string; user: { email: string } }[]>(all);
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((m) => m.userId))).toEqual(
      new Set([customer.id, other.id]),
    );
    expect(rows[0].user.email).toBeTruthy();

    // The owner is joined column by column precisely so the entity's secrets
    // do not ride along.
    const text = await all.text();
    expect(text).not.toContain('passwordHash');
    expect(text).not.toContain('refreshTokenHash');
    expect(text).not.toMatch(/\$2[aby]\$/);

    // The per-user view stays inside one tenant.
    const scoped = await request.get(`/admin/users/${customer.id}/messages`, {
      headers: auth(admin.accessToken),
    });
    const scopedRows = await payload<{ userId: string }[]>(scoped);
    expect(scopedRows.map((m) => m.userId)).toEqual([customer.id]);
  });

  test('an unknown message status is a bad request, not a database error', async ({
    request,
  }) => {
    for (const path of [
      '/admin/messages',
      `/admin/users/${customer.id}/messages`,
    ]) {
      // An unvalidated status used to reach Postgres and come back as an enum
      // cast error, which is a 500 for what is plainly a client mistake.
      const bad = await request.get(`${path}?status=delivered_maybe`, {
        headers: auth(admin.accessToken),
      });
      expect(bad.status(), `${path}: ${await bad.text()}`).toBe(400);
      expect((await errorOf(bad)).code).toBe('VALIDATION_ERROR');

      const good = await request.get(`${path}?status=expired`, {
        headers: auth(admin.accessToken),
      });
      expect(good.status(), `${path}: ${await good.text()}`).toBe(200);
      expect(await payload<unknown[]>(good)).toHaveLength(0);
    }
  });

  test('the per-user message filters each really narrow the result', async ({
    request,
  }) => {
    // status and phoneNumber are pinned elsewhere; startDate/endDate, apiKeyId
    // and provider were never exercised — and an accepted-then-dropped filter
    // returning every row is this suite's own stated failure mode.
    const keyRes = await request.post('/api-keys', {
      data: { label: 'drilldown-filter' },
      headers: auth(customer.accessToken),
    });
    expect(keyRes.status(), await keyRes.text()).toBe(201);
    const apiKey = await payload<{ id: string }>(keyRes);

    const oldId = await seedDeliveredMessage(customer.id, {
      updatedAt: new Date('2026-01-10T06:00:00.000Z'),
    });
    const keyedId = await seedDeliveredMessage(customer.id, {
      updatedAt: new Date('2026-02-10T06:00:00.000Z'),
    });
    await sql(
      `UPDATE "messages" SET "apiKeyId" = $2, "provider" = 'fast2sms' WHERE "id" = $1`,
      [keyedId, apiKey.id],
    );
    const recentId = await seedDeliveredMessage(customer.id, {
      updatedAt: new Date('2026-03-10T06:00:00.000Z'),
    });

    const base = `/admin/users/${customer.id}/messages`;
    const idsOf = async (qs: string) => {
      const res = await request.get(`${base}?${qs}`, {
        headers: auth(admin.accessToken),
      });
      expect(res.status(), `${qs}: ${await res.text()}`).toBe(200);
      return (await payload<{ id: string }[]>(res)).map((m) => m.id);
    };

    // The window keeps only the middle message: startDate is inclusive-from,
    // endDate inclusive-to, both against createdAt.
    expect(
      await idsOf('startDate=2026-02-01&endDate=2026-02-28'),
    ).toEqual([keyedId]);
    // Only the from-edge: the January row falls away, both later ones stay.
    expect(new Set(await idsOf('startDate=2026-02-01'))).toEqual(
      new Set([keyedId, recentId]),
    );
    // The key filter keeps the one send made with that credential.
    expect(await idsOf(`apiKeyId=${apiKey.id}`)).toEqual([keyedId]);
    // The provider filter is exact-match, not a substring.
    expect(await idsOf('provider=fast2sms')).toEqual([keyedId]);
    expect(await idsOf('provider=fast')).toEqual([]);
    // A well-formed key nobody owns matches nothing rather than everything.
    expect(await idsOf(`apiKeyId=${GHOST_ID}`)).toEqual([]);

    // Malformed spellings are refused, not dropped.
    for (const qs of ['startDate=notadate', 'apiKeyId=not-a-uuid']) {
      const res = await request.get(`${base}?${qs}`, {
        headers: auth(admin.accessToken),
      });
      expect(res.status(), `${qs} was accepted`).toBe(400);
      expect((await errorOf(res)).code).toBe('VALIDATION_ERROR');
    }
  });

  test('the platform-wide search narrows by template, provider and date range', async ({
    request,
  }) => {
    // The same audit hole on the cross-tenant view: only status and
    // phoneNumber had ever been exercised.
    const other = await createCustomer(request);
    const [template] = await sql<{ id: string }>(
      `SELECT "id" FROM "otp_templates" WHERE "deletedAt" IS NULL LIMIT 1`,
    );
    test.skip(!template, 'no system template seeded in this environment');

    const templatedId = await seedDeliveredMessage(customer.id, {
      updatedAt: new Date('2026-02-10T06:00:00.000Z'),
    });
    await sql(
      `UPDATE "messages" SET "otpTemplateId" = $2, "provider" = 'fast2sms' WHERE "id" = $1`,
      [templatedId, template.id],
    );
    const plainId = await seedDeliveredMessage(other.id, {
      updatedAt: new Date('2026-03-10T06:00:00.000Z'),
    });

    const idsOf = async (qs: string) => {
      const res = await request.get(`/admin/messages?${qs}`, {
        headers: auth(admin.accessToken),
      });
      expect(res.status(), `${qs}: ${await res.text()}`).toBe(200);
      return (await payload<{ id: string }[]>(res)).map((m) => m.id);
    };

    expect(await idsOf(`otpTemplateId=${template.id}`)).toEqual([templatedId]);
    expect(await idsOf(`otpTemplateId=${GHOST_ID}`)).toEqual([]);
    expect(await idsOf('provider=fast2sms')).toEqual([templatedId]);
    expect(
      await idsOf('startDate=2026-03-01&endDate=2026-03-31'),
    ).toEqual([plainId]);
    expect(new Set(await idsOf('startDate=2026-01-01'))).toEqual(
      new Set([templatedId, plainId]),
    );

    const bad = await request.get('/admin/messages?endDate=lastweek', {
      headers: auth(admin.accessToken),
    });
    expect(bad.status()).toBe(400);
    expect((await errorOf(bad)).code).toBe('VALIDATION_ERROR');
  });

  test('the overview carries the trend and enrichment the panel builds its header from', async ({
    request,
  }) => {
    // messagesTrend, tags/derivedTags/metrics were never asserted, and
    // apiKeyCount only ever at 0.
    const keyRes = await request.post('/api-keys', {
      data: { label: 'overview-count' },
      headers: auth(customer.accessToken),
    });
    expect(keyRes.status(), await keyRes.text()).toBe(201);

    await seedDeliveredMessage(customer.id, { costAmount: 0.25 });
    await seedDeliveredMessage(customer.id, {
      costAmount: 0.25,
      status: 'failed',
    });

    const res = await request.get(`/admin/users/${customer.id}/overview`, {
      headers: auth(admin.accessToken),
    });
    expect(res.status(), await res.text()).toBe(200);

    const body = await payload<{
      apiKeyCount: number;
      messagesTrend: {
        date: string;
        total: number;
        delivered: number;
        failed: number;
      }[];
      tags: unknown[];
      derivedTags: { kind: string; key: string }[];
      metrics: {
        balance: number;
        messages30d: number;
        delivered30d: number;
        failed30d: number;
        deliveryRate30d: number | null;
      } | null;
    }>(res);

    expect(body.apiKeyCount).toBe(1);

    // Both seeds carry today's timestamp, so the seven-day trend holds exactly
    // one bucket — today's IST date — with the delivered/failed split intact.
    const todayIst = new Date(Date.now() + 5.5 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);
    expect(body.messagesTrend).toEqual([
      { date: todayIst, total: 2, delivered: 1, failed: 1 },
    ]);

    expect(body.tags).toEqual([]);
    expect(body.derivedTags.map((t) => t.key)).toContain('topup:0');
    expect(body.metrics?.balance).toBe(10);
    expect(body.metrics?.messages30d).toBe(2);
    expect(body.metrics?.delivered30d).toBe(1);
    expect(body.metrics?.failed30d).toBe(1);
    expect(body.metrics?.deliveryRate30d).toBe(50);
  });

  test('transaction date, search and sort parameters are honoured, not dropped', async ({
    request,
  }) => {
    // The welcome credit exists from registration; two more entries with
    // known descriptions and dates give every unexercised parameter a row to
    // find — and a row it must exclude.
    // The same two rows the hand-written insert wrote — ₹1 then ₹2 out of the
    // ₹10 welcome credit — except the wallet now ends on the 7 they add up to
    // instead of staying on 10. Nothing in this test reads the balance; the
    // per-user metrics that do are asserted in the overview test above, which
    // seeds no transactions.
    await seedLedger(
      customer.id,
      {
        delta: -1,
        description: 'january needle-alpha',
        createdAt: new Date('2026-01-15T06:00:00.000Z'),
      },
      {
        delta: -2,
        description: 'march needle-beta',
        createdAt: new Date('2026-03-15T06:00:00.000Z'),
      },
    );

    const base = `/admin/users/${customer.id}/transactions`;
    const rowsOf = async (qs: string) => {
      const res = await request.get(`${base}?${qs}`, {
        headers: auth(admin.accessToken),
      });
      expect(res.status(), `${qs}: ${await res.text()}`).toBe(200);
      return payload<{ description: string; amount: string }[]>(res);
    };

    // The window keeps only January's entry.
    const january = await rowsOf('startDate=2026-01-01&endDate=2026-01-31');
    expect(january.map((t) => t.description)).toEqual(['january needle-alpha']);

    // search is a substring match over the description.
    const searched = await rowsOf('search=needle');
    expect(searched.map((t) => t.description).sort()).toEqual([
      'january needle-alpha',
      'march needle-beta',
    ]);
    expect((await rowsOf('search=needle-beta')).map((t) => t.description)).toEqual(
      ['march needle-beta'],
    );

    // A positive sort assertion at last: ascending really is oldest-first,
    // and flipping the direction reverses the same rows.
    const asc = await rowsOf('sortBy=created_at&sortOrder=asc');
    const desc = await rowsOf('sortBy=created_at&sortOrder=desc');
    expect(asc.map((t) => t.description)).toEqual([
      'january needle-alpha',
      'march needle-beta',
      // The welcome credit was written moments ago, so it sorts last.
      expect.stringContaining('Welcome'),
    ]);
    expect(desc.map((t) => t.description)).toEqual(
      [...asc.map((t) => t.description)].reverse(),
    );
  });

  test('the two message views disagree about a formatted phone number', async ({
    request,
  }) => {
    // seedDeliveredMessage stores +919000000000. An operator pastes what the
    // complainant wrote, spaces and all.
    await seedDeliveredMessage(customer.id, { costAmount: 0.25 });
    const typed = encodeURIComponent('+91 90000 00000');

    // searchAllAdmin reduces the term to digits first, so this matches.
    const platform = await request.get(`/admin/messages?phoneNumber=${typed}`, {
      headers: auth(admin.accessToken),
    });
    expect(platform.status(), await platform.text()).toBe(200);
    expect(await payload<unknown[]>(platform)).toHaveLength(1);

    // findByUserAdmin only trims, so the same term matches nothing on the
    // customer's own tab. Pinned as current behaviour; reported, because the
    // two tabs sit next to each other in the same panel.
    const perUser = await request.get(
      `/admin/users/${customer.id}/messages?phoneNumber=${typed}`,
      { headers: auth(admin.accessToken) },
    );
    expect(perUser.status(), await perUser.text()).toBe(200);
    expect(
      await payload<unknown[]>(perUser),
      'the per-user message filter now normalises phone numbers — check the report',
    ).toHaveLength(0);

    // The unformatted number works on both.
    const digits = await request.get(
      `/admin/users/${customer.id}/messages?phoneNumber=919000000000`,
      { headers: auth(admin.accessToken) },
    );
    expect(await payload<unknown[]>(digits)).toHaveLength(1);
  });
});
