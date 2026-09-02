import { test, expect, APIRequestContext } from '@playwright/test';
import { resetDb, closeDb, sql } from '../helpers/db.js';
import {
  createAdmin,
  createCustomer,
  onboardCustomer,
  auth,
  payload,
  Customer,
} from '../helpers/actors.js';
import {
  CatalogueChannel,
  CatalogueTemplate,
  SYSTEM_TEMPLATE,
  TEMPLATE_FIXTURE,
  channelTemplates,
  names,
  read,
  removeFixtures,
  seedChannel,
  templates,
} from './helpers.js';

/**
 * What the channel and template catalogue shows: GET /channels,
 * GET /channels/:id/templates and GET /templates.
 *
 * Everything here is about the two filters in ChannelsService —
 * `isActive` on channels, `status = 'published'` on templates — because those
 * are what decide whether a half-written template is offered to a paying
 * customer.
 */

test.describe('channel and template catalogue', () => {
  let admin: Customer;
  let customer: Customer;
  let smsChannelId: string;

  test.beforeEach(async ({ request }) => {
    await resetDb();
    // Belt and braces: if a previous run died mid-test its rows are still
    // here, and `channels` is not something resetDb truncates.
    await removeFixtures();

    admin = await createAdmin(request);
    customer = await createCustomer(request);
    await onboardCustomer(customer.id);

    const [row] = await sql<{ id: string }>(
      `SELECT "id" FROM "channels" WHERE "name" = 'sms'`,
    );
    // Seeded by onModuleInit on every boot. Its absence means the server under
    // test never finished starting, and every assertion below would be noise.
    expect(row?.id, 'the sms channel was not seeded at boot').toBeTruthy();
    smsChannelId = row.id;
  });

  test.afterEach(async () => {
    await removeFixtures();
  });

  test.afterAll(async () => {
    await closeDb();
  });

  /** Templates are born as drafts; the admin route is the only way in. */
  async function createDraft(
    request: APIRequestContext,
    channelId: string,
    name: string,
  ): Promise<string> {
    const res = await request.post('/admin/templates', {
      data: { channelId, name, body: `Your OTP is {{otp}} for ${name}` },
      headers: auth(admin.accessToken),
    });
    expect(res.ok(), await res.text()).toBeTruthy();
    const created = await payload<CatalogueTemplate>(res);
    expect(created.status, 'a new template was not a draft').toBe('draft');
    return created.id;
  }

  const publish = (request: APIRequestContext, id: string) =>
    request.patch(`/admin/templates/${id}/publish`, {
      headers: auth(admin.accessToken),
    });

  const unpublish = (request: APIRequestContext, id: string) =>
    request.patch(`/admin/templates/${id}/unpublish`, {
      headers: auth(admin.accessToken),
    });

  const removeTemplate = (request: APIRequestContext, id: string) =>
    request.delete(`/admin/templates/${id}`, {
      headers: auth(admin.accessToken),
    });

  async function publishedTemplate(
    request: APIRequestContext,
    channelId: string,
    name: string,
  ): Promise<string> {
    const id = await createDraft(request, channelId, name);
    const res = await publish(request, id);
    expect(res.ok(), await res.text()).toBeTruthy();
    return id;
  }

  test.describe('what it shows', () => {
    test('a draft is missing from the per-channel list until it is published', async ({
      request,
    }) => {
      // The whole point of the status column: unreviewed copy must not reach a
      // customer's OTP. admin/ops-channels-templates.spec.ts already walks that
      // roundtrip against /templates, so this one walks the same three states
      // against /channels/:id/templates — a separate service method
      // (findTemplatesByChannel) with its own copy of the status filter, and
      // the one route that spec never calls.
      const name = `${TEMPLATE_FIXTURE} Draft Roundtrip`;
      const id = await createDraft(request, smsChannelId, name);

      expect(
        names(
          await channelTemplates(request, customer.accessToken, smsChannelId),
        ),
      ).not.toContain(name);

      const published = await publish(request, id);
      expect(published.ok(), await published.text()).toBeTruthy();

      expect(
        names(
          await channelTemplates(request, customer.accessToken, smsChannelId),
        ),
      ).toContain(name);

      const withdrawn = await unpublish(request, id);
      expect(withdrawn.ok(), await withdrawn.text()).toBeTruthy();

      expect(
        names(
          await channelTemplates(request, customer.accessToken, smsChannelId),
        ),
      ).not.toContain(name);
    });

    test('templates are scoped to the channel asked for', async ({
      request,
    }) => {
      const other = await seedChannel();
      const smsName = `${TEMPLATE_FIXTURE} Sms Only`;
      const otherName = `${TEMPLATE_FIXTURE} Other Only`;

      await publishedTemplate(request, smsChannelId, smsName);
      await publishedTemplate(request, other.id, otherName);

      const onSms = names(
        await channelTemplates(request, customer.accessToken, smsChannelId),
      );
      expect(onSms).toContain(smsName);
      expect(
        onSms,
        "another channel's template leaked into this one",
      ).not.toContain(otherName);

      const onOther = names(
        await channelTemplates(request, customer.accessToken, other.id),
      );
      expect(onOther).toEqual([otherName]);

      // The unscoped list is the union, and is the only place both appear.
      const all = names(await templates(request, customer.accessToken));
      expect(all).toContain(smsName);
      expect(all).toContain(otherName);
    });

    test('an inactive channel disappears from /channels while its templates stay listed', async ({
      request,
    }) => {
      // Pinned as current behaviour, and flagged: findActiveChannels filters on
      // isActive but findAllActiveTemplates filters only on status, so
      // retiring a channel hides it from the picker while the templates riding
      // on it are still offered — a client that renders /templates without
      // cross-checking /channels will offer a channel that no longer exists.
      const retired = await seedChannel({ isActive: false });
      const name = `${TEMPLATE_FIXTURE} On Retired Channel`;
      await publishedTemplate(request, retired.id, name);

      const channels = await read<CatalogueChannel[]>(
        request,
        customer.accessToken,
        '/channels',
      );
      expect(channels.map((c) => c.id)).not.toContain(retired.id);
      expect(channels.every((c) => c.isActive)).toBe(true);
      expect(
        channels.map((c) => c.name),
        'the seeded sms channel is missing from /channels',
      ).toContain('sms');

      expect(names(await templates(request, customer.accessToken))).toContain(
        name,
      );
      expect(
        names(
          await channelTemplates(request, customer.accessToken, retired.id),
        ),
      ).toEqual([name]);
    });

    test('a deleted template leaves both catalogue lists', async ({
      request,
    }) => {
      // admin/ops-channels-templates.spec.ts already proves the admin routes
      // answer 404 for a soft-deleted template, so that matrix is not repeated
      // here. What it does not check is the customer-facing side: softRemove
      // only sets deletedAt, and both reads here have to inherit the
      // repository's `deletedAt IS NULL` for the row to actually disappear.
      const name = `${TEMPLATE_FIXTURE} Deleted`;
      const id = await publishedTemplate(request, smsChannelId, name);
      expect(names(await templates(request, customer.accessToken))).toContain(
        name,
      );
      expect(
        names(
          await channelTemplates(request, customer.accessToken, smsChannelId),
        ),
      ).toContain(name);

      const removed = await removeTemplate(request, id);
      expect(removed.ok(), await removed.text()).toBeTruthy();

      expect(
        names(await templates(request, customer.accessToken)),
      ).not.toContain(name);
      expect(
        names(
          await channelTemplates(request, customer.accessToken, smsChannelId),
        ),
      ).not.toContain(name);
    });

    test('the catalogue is ordered by name, and repeated reads agree', async ({
      request,
    }) => {
      // Created out of order on purpose: insertion order and name order have to
      // disagree for the ORDER BY to be proved.
      const alpha = `${TEMPLATE_FIXTURE} Alpha`;
      const mike = `${TEMPLATE_FIXTURE} Mike`;
      const zulu = `${TEMPLATE_FIXTURE} Zulu`;
      await publishedTemplate(request, smsChannelId, zulu);
      await publishedTemplate(request, smsChannelId, alpha);
      await publishedTemplate(request, smsChannelId, mike);

      const reads = await Promise.all(
        Array.from({ length: 4 }, () =>
          templates(request, customer.accessToken),
        ),
      );

      for (const rows of reads) {
        const mine = names(rows).filter((n) => n.startsWith(TEMPLATE_FIXTURE));
        expect(mine).toEqual([alpha, mike, zulu]);
        // Unstable ordering only shows up when the same list is paged or
        // diffed, so every read has to be byte-identical to the first.
        expect(rows).toEqual(reads[0]);
      }

      const perChannel = names(
        await channelTemplates(request, customer.accessToken, smsChannelId),
      ).filter((n) => n.startsWith(TEMPLATE_FIXTURE));
      expect(perChannel).toEqual([alpha, mike, zulu]);
    });

    test('the unscoped list carries its channel and the per-channel list does not', async ({
      request,
    }) => {
      // findAllActiveTemplates joins the channel; findTemplatesByChannel does
      // not. A panel that renders `row.channel.displayName` works against one
      // list and throws against the other, so the difference is worth pinning
      // rather than discovering in a browser.
      const name = `${TEMPLATE_FIXTURE} Relation`;
      await publishedTemplate(request, smsChannelId, name);

      const all = await templates(request, customer.accessToken);
      const mine = all.find((t) => t.name === name);
      expect(mine, 'the published template was not listed').toBeTruthy();
      expect(mine?.channel?.id).toBe(smsChannelId);
      expect(mine?.channel?.name).toBe('sms');
      expect(mine?.channelId).toBe(smsChannelId);

      const scoped = await channelTemplates(
        request,
        customer.accessToken,
        smsChannelId,
      );
      const same = scoped.find((t) => t.name === name);
      expect(same?.channelId).toBe(smsChannelId);
      expect(same).not.toHaveProperty('channel');
    });

    test('query parameters are ignored and cannot surface a draft or reach ORDER BY', async ({
      request,
    }) => {
      // Neither handler takes a @Query, so a client that assumes these filter
      // gets the whole published list back. What must never happen is the
      // opposite: `?status=draft` handing over unpublished copy, or a sort key
      // reaching SQL the way the admin list's used to before it was
      // whitelisted.
      const draft = `${TEMPLATE_FIXTURE} Ignored Draft`;
      await createDraft(request, smsChannelId, draft);
      const baseline = await templates(request, customer.accessToken);

      for (const query of [
        '?status=draft',
        '?page=0&limit=0',
        '?page=-1&limit=99999999',
        '?sortBy=name); DROP TABLE users;--',
        '?sortBy[]=name&sortBy[]=status',
        `?channelId=00000000-0000-4000-8000-000000000000`,
        '?limit=abc',
      ]) {
        const res = await request.get(`/templates${query}`, {
          headers: auth(customer.accessToken),
        });
        expect(res.status(), `${query}: ${await res.text()}`).toBe(200);

        const rows = await payload<CatalogueTemplate[]>(res);
        expect(rows, `${query} changed the response`).toEqual(baseline);
        expect(names(rows), `${query} exposed a draft`).not.toContain(draft);
        expect(rows.every((r) => r.status === 'published')).toBe(true);
      }

      // The injected sort key must not have taken anything with it.
      const [{ count }] = await sql<{ count: string }>(
        `SELECT COUNT(*)::int AS count FROM "users"`,
      );
      expect(Number(count)).toBeGreaterThan(0);
    });

    test('the system OTP template is seeded exactly once', async ({
      request,
    }) => {
      // seedDefaults runs on every boot and only stands down when the sms
      // channel already has a template. If that guard is ever loosened, each
      // restart adds another copy and the customer's picker fills with
      // duplicates.
      const seeded = (await templates(request, customer.accessToken)).filter(
        (t) => t.name === SYSTEM_TEMPLATE,
      );
      expect(seeded.length, `${SYSTEM_TEMPLATE} is duplicated`).toBe(1);
      expect(seeded[0].body).toContain('{{otp}}');
      expect(seeded[0].channelId).toBe(smsChannelId);

      const smsChannels = (
        await read<CatalogueChannel[]>(
          request,
          customer.accessToken,
          '/channels',
        )
      ).filter((c) => c.name === 'sms');
      expect(smsChannels.length, 'the sms channel is duplicated').toBe(1);
      expect(smsChannels[0].displayName).toBe('SMS');
    });

    // `POST /admin/templates` against a well-formed but unknown channelId is a
    // 404/NOT_FOUND. That belongs to the admin surface and is already asserted
    // in admin/ops-channels-templates.spec.ts (`template validation boundaries
    // are enforced`), so it is not repeated here.
  });
});
