import { test, expect } from '@playwright/test';
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
  CatalogueTemplate,
  channelTemplates,
  errorCode,
  removeFixtures,
} from './helpers.js';

/**
 * The channel id on GET /channels/:id/templates.
 *
 * ChannelsController is declared `@Controller()` with no prefix, so this route
 * sits at the API root beside /auth and /otp rather than under a namespace of
 * its own. What is pinned here is the ParseUUIDPipe in front of the id and what
 * findTemplatesByChannel does with an id that parses but matches nothing.
 */

test.describe('channel and template catalogue', () => {
  let customer: Customer;
  let smsChannelId: string;

  test.beforeEach(async ({ request }) => {
    await resetDb();
    // Belt and braces: if a previous run died mid-test its rows are still
    // here, and `channels` is not something resetDb truncates.
    await removeFixtures();

    // The admin account is not read here, but creating it keeps this file's
    // fixture identical to the rest of the catalogue suite it was split from.
    await createAdmin(request);
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

  test.describe('channel ids', () => {
    test('a malformed channel id is a 400, never a list and never a 500', async ({
      request,
    }) => {
      const malformed = [
        'not-a-uuid',
        '123',
        // One hex digit short — the shape most likely to arrive from a
        // truncated copy-paste.
        '00000000-0000-4000-8000-00000000000',
        '{00000000-0000-4000-8000-000000000000}',
        // Leading and trailing whitespace: the pipe's regex is anchored, so
        // this must not be trimmed into a valid id.
        ' 00000000-0000-4000-8000-000000000000 ',
        "' OR 1=1--",
        'a'.repeat(300),
      ];

      for (const id of malformed) {
        const res = await request.get(
          `/channels/${encodeURIComponent(id)}/templates`,
          { headers: auth(customer.accessToken) },
        );
        expect(res.status(), `"${id.slice(0, 40)}": ${await res.text()}`).toBe(
          400,
        );
        expect(await errorCode(res)).toBe('INVALID_INPUT');
      }
    });

    test('an array of channel ids is refused rather than silently using the first', async ({
      request,
    }) => {
      // `?id=` style duplication cannot happen on a path segment, but a client
      // that builds the URL from an array produces `a,b`. ParseUUIDPipe must
      // refuse the whole thing rather than a lenient parse taking the first.
      const pair = `${smsChannelId},00000000-0000-4000-8000-000000000000`;
      const res = await request.get(
        `/channels/${encodeURIComponent(pair)}/templates`,
        { headers: auth(customer.accessToken) },
      );
      expect(res.status(), await res.text()).toBe(400);
      expect(await errorCode(res)).toBe('INVALID_INPUT');
    });

    test('a well-formed channel id nobody owns returns an empty list, not a 404', async ({
      request,
    }) => {
      // ParseUUIDPipe is constructed without a version, so it validates against
      // the version-agnostic pattern: the nil UUID and non-v4 ids all pass it.
      // findTemplatesByChannel then filters on channelId without checking the
      // channel exists, so an unknown channel is indistinguishable from a
      // channel with nothing published on it. Pinned as current behaviour — the
      // sibling admin route answers 404 for an unknown template id.
      for (const id of [
        '00000000-0000-0000-0000-000000000000',
        '11111111-1111-1111-1111-111111111111',
        '9f8a7b6c-1d2e-4f30-8a9b-0c1d2e3f4a5b',
      ]) {
        const res = await request.get(`/channels/${id}/templates`, {
          headers: auth(customer.accessToken),
        });
        expect(res.status(), `${id}: ${await res.text()}`).toBe(200);
        expect(await payload<CatalogueTemplate[]>(res)).toEqual([]);
      }
    });

    test('a channel id is matched case-insensitively', async ({ request }) => {
      // The column is a Postgres uuid, not text. If it were ever migrated to
      // varchar, an id upper-cased by a client would quietly return nothing.
      const lower = await channelTemplates(
        request,
        customer.accessToken,
        smsChannelId,
      );
      expect(
        lower.length,
        'the seeded system template is missing from the sms channel',
      ).toBeGreaterThan(0);

      const upper = await channelTemplates(
        request,
        customer.accessToken,
        smsChannelId.toUpperCase(),
      );
      expect(upper).toEqual(lower);
    });
  });
});
