import { test, expect, APIRequestContext } from '@playwright/test';
import { resetDb, closeDb, sql } from '../helpers/db.js';
import {
  createCustomer,
  onboardCustomer,
  unique,
  auth,
  payload,
  Customer,
} from '../helpers/actors.js';
import { expectNoProviderDetail } from './helpers.js';
import { FALLBACK_RENDERED, otpBody, phone, sendOtp } from '../otp/helpers.js';

/**
 * What a customer can read about a message they sent: the text, and the name
 * of the template that produced it.
 *
 * `content` is the fixed placeholder "OTP sent", so until 2026-10-18 the
 * dashboard could not show a customer their own message. `renderedContent`
 * and a nested `otpTemplate: { id, name }` now ride on every customer route.
 * What these specs defend is the other side of that: the template ref must
 * carry nothing but its id and name (its body and `metadata` name the
 * provider), the live code must never be in the text, and the new fields must
 * not turn the tenant boundary into a hole.
 */
test.describe('message text and template name on the customer routes', () => {
  let customer: Customer;
  let channelId: string | null = null;
  const created: string[] = [];

  test.beforeEach(async ({ request }) => {
    await resetDb();
    customer = await createCustomer(request);
    await onboardCustomer(customer.id);

    const [channel] = await sql<{ id: string }>(
      `SELECT "id" FROM "channels" WHERE "deletedAt" IS NULL LIMIT 1`,
    );
    channelId = channel?.id ?? null;
  });

  test.afterEach(async () => {
    // Templates are outside resetDb's truncation list, so a fixture left
    // behind would show up in every later /templates listing. Soft-deleting
    // keeps the messages foreign key valid while hiding the row.
    if (created.length) {
      await sql(
        `UPDATE "otp_templates" SET "deletedAt" = now() WHERE "id" = ANY($1::uuid[])`,
        [created],
      );
      created.length = 0;
    }
  });

  test.afterAll(async () => {
    await closeDb();
  });

  async function seedTemplate(
    body: string,
    metadata: Record<string, string> = {},
  ) {
    const name = unique('e2e-name');
    const [row] = await sql<{ id: string }>(
      `INSERT INTO "otp_templates" ("name", "body", "channelId", "status", "metadata")
       VALUES ($1, $2, $3, 'published', $4::jsonb) RETURNING "id"`,
      [name, body, channelId, JSON.stringify(metadata)],
    );
    created.push(row.id);
    return { id: row.id, name };
  }

  /** A message as 2Factor's flow leaves it: text stored, template resolved or not. */
  async function seedMessage(
    userId: string,
    opts: {
      templateId?: string | null;
      renderedContent?: string | null;
      status?: string;
      createdAt?: Date;
    } = {},
  ): Promise<string> {
    const when = opts.createdAt ?? new Date();
    const [row] = await sql<{ id: string }>(
      `INSERT INTO "messages"
         ("userId", "phoneNumber", "content", "provider", "status", "costAmount",
          "otpTemplateId", "renderedContent", "createdAt", "updatedAt")
       VALUES ($1, '+919000000000', 'OTP sent', 'console', $2, 0.25, $3, $4, $5, $5)
       RETURNING "id"`,
      [
        userId,
        opts.status ?? 'delivered',
        opts.templateId ?? null,
        opts.renderedContent === undefined
          ? 'Hello ******'
          : opts.renderedContent,
        when,
      ],
    );
    return row.id;
  }

  const list = async (request: APIRequestContext, token: string, qs = '') => {
    const res = await request.get(`/messages${qs}`, { headers: auth(token) });
    expect(res.status(), await res.text()).toBe(200);
    return payload<Record<string, any>[]>(res);
  };

  test('a message sent with a template reads back its text and the template name', async ({
    request,
  }) => {
    test.skip(!channelId, 'no channel seeded in this environment');
    const tpl = await seedTemplate('Code {{otp}} for {{appName}}');
    await seedMessage(customer.id, {
      templateId: tpl.id,
      renderedContent: 'Code ****** for Acme',
    });

    const [row] = await list(request, customer.accessToken);

    expect(row.renderedContent).toBe('Code ****** for Acme');
    expect(row.otpTemplate).toEqual({ id: tpl.id, name: tpl.name });
    expectNoProviderDetail(row);
  });

  test('the template ref carries nothing but its id and name', async ({
    request,
  }) => {
    // The template's body is the operator-approved text and `metadata` maps it
    // to the provider's own template name. Neither is the customer's to read,
    // and a row-level serialiser that "just returned the relation" would hand
    // over both.
    test.skip(!channelId, 'no channel seeded in this environment');
    const tpl = await seedTemplate('SECRET-BODY {{otp}}', {
      '2factor': 'PROVIDER_TEMPLATE_X',
    });
    const id = await seedMessage(customer.id, { templateId: tpl.id });

    for (const row of [
      (await list(request, customer.accessToken))[0],
      await payload<Record<string, any>>(
        await request.get(`/messages/${id}`, {
          headers: auth(customer.accessToken),
        }),
      ),
    ]) {
      expect(Object.keys(row.otpTemplate).sort()).toEqual(['id', 'name']);
      const text = JSON.stringify(row);
      expect(text).not.toContain('SECRET-BODY');
      expect(text).not.toContain('PROVIDER_TEMPLATE_X');
      expect(text).not.toContain('2factor');
    }
  });

  test('a send that fell back to the default text names no template', async ({
    request,
  }) => {
    await seedMessage(customer.id, {
      templateId: null,
      renderedContent: FALLBACK_RENDERED,
    });

    const [row] = await list(request, customer.accessToken);

    expect(row.renderedContent).toBe(FALLBACK_RENDERED);
    expect(row.otpTemplate).toBeNull();
  });

  test('a message from before text capture reads as null text, not as an error', async ({
    request,
  }) => {
    // Rows written before 2026-08-08 have no renderedContent and no template.
    // The UI falls back to `content`, so both must come back as explicit nulls
    // rather than missing keys or a 500 from the lookup.
    await seedMessage(customer.id, { renderedContent: null });

    const [row] = await list(request, customer.accessToken);

    expect(row.renderedContent).toBeNull();
    expect(row.otpTemplate).toBeNull();
    expect(row.content).toBe('OTP sent');
  });

  test('a template retired after the send still names its messages', async ({
    request,
  }) => {
    // Templates are soft-deleted, never removed. A lookup that skipped deleted
    // rows would blank the name on every message sent with a template an admin
    // has since retired — exactly the history this feature exists to show.
    test.skip(!channelId, 'no channel seeded in this environment');
    const tpl = await seedTemplate('Old wording {{otp}}');
    await seedMessage(customer.id, { templateId: tpl.id });
    await sql(
      `UPDATE "otp_templates" SET "deletedAt" = now() WHERE "id" = $1`,
      [tpl.id],
    );

    const [row] = await list(request, customer.accessToken);

    expect(row.otpTemplate).toEqual({ id: tpl.id, name: tpl.name });
  });

  test('one page with several templates maps every row to its own', async ({
    request,
  }) => {
    // The names come from one batched lookup keyed by id. A mapping slip —
    // indexing by position, or by the wrong id — would label rows with a
    // neighbour's template and nothing would crash.
    test.skip(!channelId, 'no channel seeded in this environment');
    const a = await seedTemplate('A {{otp}}');
    const b = await seedTemplate('B {{otp}}');
    const base = Date.now();
    const sent: Record<string, { name: string; id: string } | null> = {};
    const plan = [a, b, null, b, a];
    for (let i = 0; i < plan.length; i += 1) {
      const t = plan[i];
      const id = await seedMessage(customer.id, {
        templateId: t?.id ?? null,
        createdAt: new Date(base - i * 60_000),
      });
      sent[id] = t ? { id: t.id, name: t.name } : null;
    }

    const rows = await list(request, customer.accessToken, '?limit=10');

    expect(rows).toHaveLength(plan.length);
    for (const row of rows) {
      expect(row.otpTemplate, `row ${row.id}`).toEqual(sent[row.id]);
    }
  });

  test('the single read, the cursor list and the status check carry the same fields', async ({
    request,
  }) => {
    test.skip(!channelId, 'no channel seeded in this environment');
    const tpl = await seedTemplate('Code {{otp}}');
    const id = await seedMessage(customer.id, {
      templateId: tpl.id,
      renderedContent: 'Code ******',
    });
    const expected = {
      renderedContent: 'Code ******',
      otpTemplate: { id: tpl.id, name: tpl.name },
    };

    const one = await payload<Record<string, any>>(
      await request.get(`/messages/${id}`, {
        headers: auth(customer.accessToken),
      }),
    );
    // `cursor` must be present, even empty, for the controller to choose
    // keyset mode — see pagination.spec.ts.
    const [cursored] = await list(request, customer.accessToken, '?cursor=');
    // Delivered is terminal, so this takes the early-return branch that used
    // to be the one place a whole entity leaked.
    const check = await request.post(`/messages/${id}/check-status`, {
      headers: auth(customer.accessToken),
    });
    expect(check.status(), await check.text()).toBe(201);
    const checked = await payload<Record<string, any>>(check);

    for (const row of [one, cursored, checked]) {
      expect(row.renderedContent).toBe(expected.renderedContent);
      expect(row.otpTemplate).toEqual(expected.otpTemplate);
      expectNoProviderDetail(row);
    }
  });

  test('another customer text is never in this customer list or detail', async ({
    request,
  }) => {
    const other = await createCustomer(request);
    await onboardCustomer(other.id);
    const theirs = await seedMessage(other.id, {
      renderedContent: 'Their private text ******',
    });
    await seedMessage(customer.id, { renderedContent: 'Mine ******' });

    const rows = await list(request, customer.accessToken);
    expect(JSON.stringify(rows)).not.toContain('Their private text');
    expect(rows).toHaveLength(1);

    const detail = await request.get(`/messages/${theirs}`, {
      headers: auth(customer.accessToken),
    });
    expect(detail.status(), await detail.text()).toBe(404);
    expect(await detail.text()).not.toContain('Their private text');
  });

  test('a real OTP send stores text the customer can read, without the code', async ({
    request,
  }) => {
    // The whole feature rests on the stored text being masked when it is
    // written. This drives the real send path rather than seeding a row, so a
    // change that stored the raw text — or exposed `otp_requests.code` — fails
    // here and not in front of a customer.
    const res = await sendOtp(
      request,
      customer.accessToken,
      otpBody(phone(), '654321'),
    );
    expect(res.status(), await res.text()).toBe(201);

    const [row] = await list(request, customer.accessToken);

    expect(row.renderedContent).toBe(FALLBACK_RENDERED);
    expect(JSON.stringify(row)).not.toContain('654321');
    expect(row.otpTemplate).toBeNull();
  });

  test('a real OTP send through a template names it and still hides the code', async ({
    request,
  }) => {
    test.skip(!channelId, 'no channel seeded in this environment');
    const tpl = await seedTemplate('Code {{otp}} for {{appName}}');

    const res = await sendOtp(
      request,
      customer.accessToken,
      otpBody(phone(), '654321', { templateId: tpl.id }),
    );
    expect(res.status(), await res.text()).toBe(201);

    const [row] = await list(request, customer.accessToken);

    expect(row.renderedContent).toBe('Code ****** for StartMessaging');
    expect(JSON.stringify(row)).not.toContain('654321');
    expect(row.otpTemplate).toEqual({ id: tpl.id, name: tpl.name });
  });
});
