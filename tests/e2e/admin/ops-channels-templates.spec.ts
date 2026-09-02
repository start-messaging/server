import { test, expect } from '@playwright/test';
import { resetDb, closeDb, sql } from '../helpers/db.js';
import {
  createAdmin,
  createCustomer,
  onboardCustomer,
  seedDeliveredMessage,
  auth,
  payload,
  unique,
  Customer,
} from '../helpers/actors.js';
import {
  NOWHERE,
  FIXTURE,
  errorCode,
  errorMessage,
  pagination,
  removeFixtures,
} from './ops-helpers.js';

/**
 * Admin channels and OTP templates.
 *
 * admin/overview.spec.ts walks the happy path of these routes. This file goes after
 * the seams instead — the channel the customer list hides, the template that
 * must start life as a draft, and the state machine behind publish/unpublish.
 */

test.describe('admin ops — channels and templates', () => {
  let admin: Customer;
  let customer: Customer;
  let channelId: string;

  test.beforeEach(async ({ request }) => {
    await resetDb();
    await removeFixtures();
    admin = await createAdmin(request);
    customer = await createCustomer(request);
    await onboardCustomer(customer.id);

    const [channel] = await sql<{ id: string }>(
      `SELECT "id" FROM "channels" WHERE "name" = 'sms'`,
    );
    test.skip(!channel, 'no SMS channel seeded in this environment');
    channelId = channel.id;
  });

  test.afterEach(async () => {
    await removeFixtures();
  });

  test.afterAll(async () => {
    await closeDb();
  });

  async function makeTemplate(
    request: Parameters<typeof createCustomer>[0],
    overrides: Record<string, unknown> = {},
  ) {
    const res = await request.post('/admin/templates', {
      data: {
        name: unique(`${FIXTURE}tpl`),
        body: 'Your OTP is {{otp}}',
        channelId,
        ...overrides,
      },
      headers: auth(admin.accessToken),
    });
    expect(res.status(), await res.text()).toBe(201);
    return payload<{ id: string; name: string; status: string }>(res);
  }

  test('the admin channel list shows the channels the customer list hides', async ({
    request,
  }) => {
    // /channels filters on isActive, so a channel switched off during an
    // incident vanishes from the customer API. The admin list must still show
    // it, or the panel offers no way to see why sending stopped.
    const name = unique(`${FIXTURE}chan`);
    await sql(
      `INSERT INTO "channels" ("name", "displayName", "isActive") VALUES ($1, $2, false)`,
      [name, 'Disabled by e2e'],
    );

    try {
      const adminList = await request.get('/admin/channels', {
        headers: auth(admin.accessToken),
      });
      expect(adminList.status(), await adminList.text()).toBe(200);
      const adminNames = (await payload<{ name: string }[]>(adminList)).map(
        (c) => c.name,
      );
      expect(adminNames).toContain(name);
      expect(adminNames).toContain('sms');

      const customerList = await request.get('/channels', {
        headers: auth(customer.accessToken),
      });
      const customerNames = (
        await payload<{ name: string }[]>(customerList)
      ).map((c) => c.name);
      expect(customerNames).not.toContain(name);
    } finally {
      await sql(`DELETE FROM "channels" WHERE "name" = $1`, [name]);
    }
  });

  test('a new template is a draft even when the request says otherwise', async ({
    request,
  }) => {
    // `status` is not on CreateTemplateDto, so the pipe strips it and the
    // service pins DRAFT. If that ever changed, anyone with panel access could
    // put unreviewed text in front of live traffic in one request.
    const created = await makeTemplate(request, {
      status: 'published',
      id: NOWHERE,
      deletedAt: null,
    });

    expect(created.status).toBe('draft');
    expect(created.id).not.toBe(NOWHERE);

    const [row] = await sql<{ status: string }>(
      `SELECT "status" FROM "otp_templates" WHERE "id" = $1`,
      [created.id],
    );
    expect(row.status).toBe('draft');
  });

  test('a draft is invisible to customers until it is published, and hidden again when it is not', async ({
    request,
  }) => {
    const template = await makeTemplate(request);

    const visibleNames = async () => {
      const res = await request.get('/templates', {
        headers: auth(customer.accessToken),
      });
      expect(res.status(), await res.text()).toBe(200);
      return (await payload<{ name: string }[]>(res)).map((t) => t.name);
    };

    expect(await visibleNames()).not.toContain(template.name);

    const published = await request.patch(
      `/admin/templates/${template.id}/publish`,
      { headers: auth(admin.accessToken) },
    );
    expect(published.status(), await published.text()).toBe(200);
    expect(await visibleNames()).toContain(template.name);

    const unpublished = await request.patch(
      `/admin/templates/${template.id}/unpublish`,
      { headers: auth(admin.accessToken) },
    );
    expect(unpublished.status(), await unpublished.text()).toBe(200);
    expect(await visibleNames()).not.toContain(template.name);
  });

  test('publishing twice and unpublishing a draft are both refused', async ({
    request,
  }) => {
    // Terminal-state guards. Without them the panel's publish button is a
    // no-op that reports success, and nobody notices the second click did
    // nothing until an audit asks when the template went live.
    const template = await makeTemplate(request);

    const unpublishDraft = await request.patch(
      `/admin/templates/${template.id}/unpublish`,
      { headers: auth(admin.accessToken) },
    );
    expect(unpublishDraft.status(), await unpublishDraft.text()).toBe(400);
    expect(await errorMessage(unpublishDraft)).toContain('already a draft');
    expect(await errorCode(unpublishDraft)).toBe('INVALID_INPUT');

    await request.patch(`/admin/templates/${template.id}/publish`, {
      headers: auth(admin.accessToken),
    });

    const publishAgain = await request.patch(
      `/admin/templates/${template.id}/publish`,
      { headers: auth(admin.accessToken) },
    );
    expect(publishAgain.status(), await publishAgain.text()).toBe(400);
    expect(await errorMessage(publishAgain)).toContain('already published');

    // Two simultaneous publishes of the same draft: one wins, and the other is
    // told it lost rather than being handed a server error.
    const second = await makeTemplate(request);
    const [a, b] = await Promise.all([
      request.patch(`/admin/templates/${second.id}/publish`, {
        headers: auth(admin.accessToken),
      }),
      request.patch(`/admin/templates/${second.id}/publish`, {
        headers: auth(admin.accessToken),
      }),
    ]);
    expect(a.status(), await a.text()).toBeLessThan(500);
    expect(b.status(), await b.text()).toBeLessThan(500);

    const [row] = await sql<{ status: string }>(
      `SELECT "status" FROM "otp_templates" WHERE "id" = $1`,
      [second.id],
    );
    expect(row.status).toBe('published');
  });

  test('a published template can be rewritten in place without going back to draft', async ({
    request,
  }) => {
    // The edit takes effect for live traffic immediately, with no return to
    // draft and no second approval. Pinned as it behaves today; flagged in the
    // return payload, because "published" currently means "was published once".
    const template = await makeTemplate(request);
    await request.patch(`/admin/templates/${template.id}/publish`, {
      headers: auth(admin.accessToken),
    });

    const edited = await request.patch(`/admin/templates/${template.id}`, {
      data: { body: 'Rewritten after publication: {{otp}}' },
      headers: auth(admin.accessToken),
    });
    expect(edited.status(), await edited.text()).toBe(200);

    const after = await payload<{ status: string; body: string }>(edited);
    expect(after.status).toBe('published');
    expect(after.body).toBe('Rewritten after publication: {{otp}}');

    const live = await request.get('/templates', {
      headers: auth(customer.accessToken),
    });
    const match = (await payload<{ id: string; body: string }[]>(live)).find(
      (t) => t.id === template.id,
    );
    expect(match?.body).toBe('Rewritten after publication: {{otp}}');
  });

  test('an update cannot move a template to another channel or publish it sideways', async ({
    request,
  }) => {
    // UpdateTemplateDto carries neither field, so both are stripped. Publishing
    // has its own route with its own state check, and re-homing a template
    // would silently change which channel's traffic it serves.
    const template = await makeTemplate(request);

    const res = await request.patch(`/admin/templates/${template.id}`, {
      data: {
        name: `${FIXTURE}renamed`,
        channelId: NOWHERE,
        status: 'published',
        deletedAt: new Date().toISOString(),
      },
      headers: auth(admin.accessToken),
    });
    expect(res.status(), await res.text()).toBe(200);

    const [row] = await sql<{
      name: string;
      channelId: string;
      status: string;
      deletedAt: Date | null;
    }>(
      `SELECT "name", "channelId", "status", "deletedAt" FROM "otp_templates" WHERE "id" = $1`,
      [template.id],
    );
    expect(row.name).toBe(`${FIXTURE}renamed`);
    expect(row.channelId).toBe(channelId);
    expect(row.status).toBe('draft');
    expect(row.deletedAt).toBeNull();
  });

  test('an empty update changes nothing', async ({ request }) => {
    // Every field on UpdateTemplateDto is optional, so `{}` is valid. It must
    // be inert rather than blanking the columns it did not mention.
    const template = await makeTemplate(request);

    const res = await request.patch(`/admin/templates/${template.id}`, {
      data: {},
      headers: auth(admin.accessToken),
    });
    expect(res.status(), await res.text()).toBe(200);

    const [row] = await sql<{ name: string; body: string; language: string }>(
      `SELECT "name", "body", "language" FROM "otp_templates" WHERE "id" = $1`,
      [template.id],
    );
    expect(row.name).toBe(template.name);
    expect(row.body).toBe('Your OTP is {{otp}}');
  });

  test('template validation boundaries are enforced', async ({ request }) => {
    const cases: [string, Record<string, unknown>][] = [
      ['no otp placeholder', { body: 'Your code is 123456' }],
      ['placeholder with a typo', { body: 'Your code is {{ otp }}' }],
      ['empty body', { body: '' }],
      // 493 + one space + the 7 characters of {{otp}} is 501.
      ['body one past 500', { body: `${'x'.repeat(493)} {{otp}}` }],
      ['empty name', { name: '' }],
      ['whitespace-only name', { name: '   ' }],
      ['name one past 100', { name: 'n'.repeat(101) }],
      ['missing channel', { channelId: undefined }],
      ['non-uuid channel', { channelId: 'not-a-uuid' }],
      ['blank channel', { channelId: '' }],
      ['language one past 10', { language: 'en-GB-oxend' }], // 11 characters
      ['metadata as an array', { metadata: [1, 2] }],
      ['metadata as a number', { metadata: 5 }],
    ];

    for (const [label, overrides] of cases) {
      const res = await request.post('/admin/templates', {
        data: {
          name: unique(`${FIXTURE}tpl`),
          body: 'Your OTP is {{otp}}',
          channelId,
          ...overrides,
        },
        headers: auth(admin.accessToken),
      });
      if (label === 'whitespace-only name') {
        // @IsNotEmpty passes on three spaces, so this one lands — a template
        // named "   " is creatable. Pinned so the gap is visible rather than
        // assumed closed, and removed by hand because its name carries no
        // fixture prefix for the sweep at the end of the test to find.
        expect(res.status(), await res.text()).toBe(201);
        const stray = await payload<{ id: string }>(res);
        await sql(`DELETE FROM "otp_templates" WHERE "id" = $1`, [stray.id]);
        continue;
      }
      expect(res.status(), `accepted: ${label}`).toBe(400);
    }

    // A channel that does not exist is a 404 rather than a validation error:
    // the uuid is well-formed, there is simply nothing behind it.
    const missingChannel = await request.post('/admin/templates', {
      data: {
        name: unique(`${FIXTURE}tpl`),
        body: 'Your OTP is {{otp}}',
        channelId: NOWHERE,
      },
      headers: auth(admin.accessToken),
    });
    expect(missingChannel.status(), await missingChannel.text()).toBe(404);
    expect(await errorCode(missingChannel)).toBe('NOT_FOUND');
  });

  test('a deleted template is gone from every route and cannot be brought back', async ({
    request,
  }) => {
    const template = await makeTemplate(request);
    const removed = await request.delete(`/admin/templates/${template.id}`, {
      headers: auth(admin.accessToken),
    });
    expect(removed.status(), await removed.text()).toBe(200);

    const gone: [string, string][] = [
      ['GET', `/admin/templates/${template.id}`],
      ['PATCH', `/admin/templates/${template.id}`],
      ['PATCH', `/admin/templates/${template.id}/publish`],
      ['PATCH', `/admin/templates/${template.id}/unpublish`],
      ['DELETE', `/admin/templates/${template.id}`],
    ];
    for (const [method, path] of gone) {
      const res = await request.fetch(path, {
        method,
        headers: auth(admin.accessToken),
        ...(method === 'GET' ? {} : { data: {} }),
      });
      expect(res.status(), `${method} ${path} after deletion`).toBe(404);
      expect(await errorCode(res)).toBe('NOT_FOUND');
    }

    // And it is out of the admin list, not merely out of the detail route.
    const list = await request.get(
      `/admin/templates?search=${encodeURIComponent(template.name)}`,
      { headers: auth(admin.accessToken) },
    );
    expect(await payload<unknown[]>(list)).toEqual([]);
  });

  test('deleting a template that has already sent messages leaves the history readable', async ({
    request,
  }) => {
    // The foreign key from messages is ON DELETE NO ACTION on the grounds that
    // templates are only ever soft-deleted. A hard delete here would either
    // fail outright or orphan the rows that explain what a customer was sent.
    const template = await makeTemplate(request);
    await request.patch(`/admin/templates/${template.id}/publish`, {
      headers: auth(admin.accessToken),
    });

    const messageId = await seedDeliveredMessage(customer.id, {
      costAmount: 0.25,
    });
    await sql(`UPDATE "messages" SET "otpTemplateId" = $2 WHERE "id" = $1`, [
      messageId,
      template.id,
    ]);

    const removed = await request.delete(`/admin/templates/${template.id}`, {
      headers: auth(admin.accessToken),
    });
    expect(removed.status(), await removed.text()).toBe(200);

    const [message] = await sql<{ otpTemplateId: string | null }>(
      `SELECT "otpTemplateId" FROM "messages" WHERE "id" = $1`,
      [messageId],
    );
    expect(
      message.otpTemplateId,
      'deleting a template orphaned the messages it produced',
    ).toBe(template.id);

    const [row] = await sql<{ deletedAt: Date | null }>(
      `SELECT "deletedAt" FROM "otp_templates" WHERE "id" = $1`,
      [template.id],
    );
    expect(row.deletedAt).not.toBeNull();
  });

  test('the template list refuses an unknown sort key and an off-enum status', async ({
    request,
  }) => {
    // sortBy is resolved against a whitelist before it reaches ORDER BY, and
    // the DTO refuses anything not on it. 'constructor' is in the list because
    // an allowlist tested with `in` rather than Object.hasOwn resolves it to an
    // inherited function and puts garbage in the query.
    for (const query of [
      'sortBy=passwordHash',
      'sortBy=constructor',
      'sortBy=__proto__',
      `sortBy=${encodeURIComponent('name; DROP TABLE otp_templates')}`,
      'sortBy=createdAt', // the whitelist spells it created_at
      'status=PUBLISHED',
      'status=archived',
      'status=',
      'channelId=not-a-uuid',
      'channelId=',
      `search=${'s'.repeat(201)}`,
    ]) {
      const res = await request.get(`/admin/templates?${query}`, {
        headers: auth(admin.accessToken),
      });
      expect(res.status(), `?${query} was accepted`).toBe(400);
    }

    for (const query of [
      'sortBy=created_at&sortOrder=ASC',
      'sortBy=name',
      'sortBy=status',
      'sortBy=updated_at',
      'status=draft',
      `channelId=${channelId}`,
    ]) {
      const res = await request.get(`/admin/templates?${query}`, {
        headers: auth(admin.accessToken),
      });
      expect(res.status(), `?${query} was refused: ${await res.text()}`).toBe(
        200,
      );
    }
  });

  test('the template list refuses to page past the offset ceiling', async ({
    request,
  }) => {
    // Offset pagination degrades linearly with depth, so there is a hard
    // ceiling at 50,000 rows. The boundary is asserted on both sides because a
    // >= would move it by one page and break a legitimate deep link.
    const atCeiling = await request.get('/admin/templates?page=501&limit=100', {
      headers: auth(admin.accessToken),
    });
    expect(atCeiling.status(), await atCeiling.text()).toBe(200);

    const past = await request.get('/admin/templates?page=502&limit=100', {
      headers: auth(admin.accessToken),
    });
    expect(past.status(), await past.text()).toBe(400);
    expect(await errorMessage(past)).toContain('50000');
  });

  test('paging one row at a time walks every template exactly once', async ({
    request,
  }) => {
    // Three templates created in the same instant share a createdAt to the
    // millisecond, so the sort is a tie and the id tiebreaker is the only thing
    // keeping the pages stable. Without it a row can appear on two pages while
    // another is never shown at all.
    const marker = unique(`${FIXTURE}page`);
    const created: { id: string }[] = [];
    for (let i = 0; i < 3; i += 1) {
      created.push(await makeTemplate(request, { name: `${marker}-${i}` }));
    }

    const seen: string[] = [];
    for (let page = 1; page <= 3; page += 1) {
      const res = await request.get(
        `/admin/templates?search=${marker}&limit=1&page=${page}&sortBy=created_at`,
        { headers: auth(admin.accessToken) },
      );
      expect(res.status(), await res.text()).toBe(200);

      const rows = await payload<{ id: string }[]>(res);
      expect(rows.length, `page ${page} was not full`).toBe(1);
      seen.push(rows[0].id);

      const meta = await pagination(res);
      expect(meta.totalItems).toBe(3);
      expect(meta.hasNextPage).toBe(page < 3);
    }

    expect(new Set(seen).size, 'a template was served on two pages').toBe(3);
    expect(seen.sort()).toEqual(created.map((t) => t.id).sort());

    const past = await request.get(
      `/admin/templates?search=${marker}&limit=1&page=4`,
      { headers: auth(admin.accessToken) },
    );
    expect(await payload<unknown[]>(past)).toEqual([]);
  });

  test('a template id that is not a uuid is a bad request, and one that is nobody is a 404', async ({
    request,
  }) => {
    const malformed = await request.get('/admin/templates/not-a-uuid', {
      headers: auth(admin.accessToken),
    });
    expect(malformed.status(), await malformed.text()).toBe(400);

    const missing = await request.get(`/admin/templates/${NOWHERE}`, {
      headers: auth(admin.accessToken),
    });
    expect(missing.status(), await missing.text()).toBe(404);
    expect(await errorCode(missing)).toBe('NOT_FOUND');
  });

  test('the detail read returns the live template with its channel relation', async ({
    request,
  }) => {
    // The one read this surface had no happy-path pin for: only its 400/404
    // negatives were asserted, so a broken projection — or a 500 on a real
    // id — would have passed. The panel's edit screen is built from exactly
    // this response.
    const created = await makeTemplate(request, {
      body: 'Detail code {{otp}} expires in {{expiry}} minutes',
      language: 'en',
    });

    const res = await request.get(`/admin/templates/${created.id}`, {
      headers: auth(admin.accessToken),
    });
    expect(res.status(), await res.text()).toBe(200);

    const body = await payload<{
      id: string;
      name: string;
      body: string;
      status: string;
      language: string;
      channelId: string;
      channel: { id: string; name: string } | null;
      deletedAt: string | null;
    }>(res);
    expect(body.id).toBe(created.id);
    expect(body.name).toBe(created.name);
    expect(body.body).toBe('Detail code {{otp}} expires in {{expiry}} minutes');
    expect(body.status).toBe('draft');
    expect(body.language).toBe('en');
    expect(body.channelId).toBe(channelId);
    // The relation is loaded by name, not left as a bare id — the panel shows
    // "SMS", not a uuid.
    expect(body.channel?.id).toBe(channelId);
    expect(body.channel?.name).toBe('sms');
    expect(body.deletedAt).toBeNull();

    // Publishing is visible through the same read, so the detail screen and
    // the list can never disagree about whether a template is live.
    const published = await request.patch(
      `/admin/templates/${created.id}/publish`,
      { headers: auth(admin.accessToken) },
    );
    expect(published.status(), await published.text()).toBe(200);

    const again = await request.get(`/admin/templates/${created.id}`, {
      headers: auth(admin.accessToken),
    });
    expect((await payload<{ status: string }>(again)).status).toBe('published');
  });

  test('the update DTO enforces its own guards, and a refused update changes nothing', async ({
    request,
  }) => {
    // UpdateTemplateDto has its own {{otp}} Matches, 500-char body and
    // 100-char name rules, separate from the create DTO's — and this route
    // edits templates that may be live for customer traffic, where a body
    // with no placeholder renders no code at all.
    const created = await makeTemplate(request, {
      body: 'Original {{otp}} body',
    });

    const refused: Array<[string, Record<string, unknown>]> = [
      ['a body with no {{otp}}', { body: 'Your code is ready' }],
      [
        'a body over 500 characters',
        { body: `{{otp}} ${'x'.repeat(495)}` },
      ],
      ['a name over 100 characters', { name: 'n'.repeat(101) }],
      ['a body that is not a string', { body: { otp: true } }],
    ];

    for (const [label, data] of refused) {
      const res = await request.patch(`/admin/templates/${created.id}`, {
        data,
        headers: auth(admin.accessToken),
      });
      expect(res.status(), `accepted ${label}`).toBe(400);
      expect(await errorCode(res), label).toBe('VALIDATION_ERROR');
    }

    const [row] = await sql<{ name: string; body: string }>(
      `SELECT "name", "body" FROM "otp_templates" WHERE "id" = $1`,
      [created.id],
    );
    expect(row.name).toBe(created.name);
    expect(row.body).toBe('Original {{otp}} body');

    // The boundaries themselves are legal: exactly 100 name characters must
    // start with the fixture prefix or afterEach cannot take the row back out.
    const atCap = await request.patch(`/admin/templates/${created.id}`, {
      data: {
        name: `${FIXTURE}${'n'.repeat(100 - FIXTURE.length)}`,
        body: `{{otp}} ${'x'.repeat(492)}`,
      },
      headers: auth(admin.accessToken),
    });
    expect(atCap.status(), await atCap.text()).toBe(200);

    const [updated] = await sql<{ name: string; body: string }>(
      `SELECT "name", "body" FROM "otp_templates" WHERE "id" = $1`,
      [created.id],
    );
    expect(updated.name).toHaveLength(100);
    expect(updated.body).toHaveLength(500);
  });
});
