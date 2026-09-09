import { test, expect } from '@playwright/test';
import { resetDb, closeDb, sql } from '../helpers/db.js';
import {
  createCustomer,
  onboardCustomer,
  seedDeliveredMessage,
  auth,
  payload,
  Customer,
} from '../helpers/actors.js';
import {
  errorOf,
  expectNoProviderDetail,
  seedProviderMessage,
} from './helpers.js';

/**
 * The seams around listing the customer message history (`/messages`).
 *
 * The controller is thin, and everything that can go wrong lives just
 * underneath it: a query DTO that decides what reaches Postgres, and a hand-
 * written column projection that decides what the customer is allowed to see.
 *
 * Pagination and sort-key allowlisting are covered by messages/pagination;
 * nothing here repeats them.
 */
test.describe('messages and dashboard edge cases', () => {
  let customer: Customer;

  test.beforeEach(async ({ request }) => {
    await resetDb();
    customer = await createCustomer(request);
    // Both controllers sit behind the global OnboardingGuard, so an
    // un-onboarded account cannot reach either of them. That gate has its own
    // test at the bottom of tests/e2e/messages/dashboard-stats.spec.ts;
    // everything else starts past it.
    await onboardCustomer(customer.id);
  });

  test.afterAll(async () => {
    await closeDb();
  });

  test.describe('listing messages', () => {
    test('a status outside the enum is refused instead of reaching the cast', async ({
      request,
    }) => {
      // The DTO gained @IsEnum precisely because an unknown value used to be
      // handed to Postgres and come back as an enum cast error — a 500 for what
      // is a client mistake. Casing matters too: the stored values are
      // lowercase, so "DELIVERED" is not the same string.
      for (const status of ['nonsense', 'DELIVERED', 'deleted', 'delivered ']) {
        const res = await request.get(
          `/messages?status=${encodeURIComponent(status)}`,
          { headers: auth(customer.accessToken) },
        );
        expect(res.status(), `status=${status} was accepted`).toBe(400);
        expect((await errorOf(res)).code).toBe('VALIDATION_ERROR');
      }

      const ok = await request.get('/messages?status=delivered', {
        headers: auth(customer.accessToken),
      });
      expect(ok.status(), await ok.text()).toBe(200);
    });

    test('a cleared filter is refused even though a cleared page is not', async ({
      request,
    }) => {
      // `?page=` is explicitly treated as absent (a truncated shared link), but
      // the filter fields have no such transform: a UI that clears its status
      // dropdown by emitting `?status=` gets a 400 rather than an unfiltered
      // list. Pinned as current behaviour — the inconsistency is reported, not
      // silently accepted.
      for (const qs of ['status=', 'apiKeyId=', 'startDate=', 'endDate=']) {
        const res = await request.get(`/messages?${qs}`, {
          headers: auth(customer.accessToken),
        });
        expect(res.status(), `"${qs}" was accepted`).toBe(400);
      }

      // The control for the comparison above, not an independent claim —
      // messages/pagination already owns the blank-page behaviour. Without
      // it the four assertions above read as "empty query params are refused",
      // which is exactly the wrong lesson.
      const blankPage = await request.get('/messages?page=&limit=', {
        headers: auth(customer.accessToken),
      });
      expect(blankPage.status(), await blankPage.text()).toBe(200);
    });

    test('a date filter that is not a date is refused', async ({ request }) => {
      // `@IsDateString()` is validator.js `isISO8601` with no options, which
      // is the *format-only* mode: a regex, not a calendar check. So every
      // case here has to be one the shape itself rejects — a bare epoch, a
      // swapped day/month, an impossible month, an hour past 23.
      //
      // An impossible *day* is not one of them. `2026-02-30T00:00:00.000Z`
      // matches the pattern, passes validation, and `new Date()` rolls it
      // forward to 2026-03-02, so the filter silently means something else.
      // That is worth fixing with `@IsDateString({ strict: true })`; it is not
      // a 400 today, so do not add it to this list.
      for (const startDate of [
        'yesterday',
        '2026-13-45',
        '1754000000000',
        '01-06-2026',
        '2026-06-01T25:00:00Z',
      ]) {
        const res = await request.get(
          `/messages?startDate=${encodeURIComponent(startDate)}`,
          { headers: auth(customer.accessToken) },
        );
        expect(res.status(), `startDate=${startDate} was accepted`).toBe(400);
        expect((await errorOf(res)).code).toBe('VALIDATION_ERROR');
      }
    });

    test('a range that ends before it starts returns nothing, not an error', async ({
      request,
    }) => {
      await seedDeliveredMessage(customer.id, { costAmount: 0.25 });

      const res = await request.get(
        '/messages?startDate=2026-06-01T00:00:00.000Z&endDate=2026-01-01T00:00:00.000Z',
        { headers: auth(customer.accessToken) },
      );
      expect(res.status(), await res.text()).toBe(200);
      expect(await payload<unknown[]>(res)).toEqual([]);
    });

    test('an api key filter cannot reach another customer messages', async ({
      request,
    }) => {
      // The filter is ANDed onto an owner-scoped query, so naming someone
      // else's key id must narrow to nothing rather than widen the scope.
      const other = await createCustomer(request);
      await onboardCustomer(other.id);

      const created = await request.post('/api-keys', {
        data: { label: 'theirs' },
        headers: auth(other.accessToken),
      });
      expect(created.ok(), await created.text()).toBeTruthy();
      const key = await payload<{ id: string }>(created);

      const theirMessage = await seedDeliveredMessage(other.id, {
        costAmount: 0.25,
      });
      await sql(`UPDATE "messages" SET "apiKeyId" = $2 WHERE "id" = $1`, [
        theirMessage,
        key.id,
      ]);

      const res = await request.get(`/messages?apiKeyId=${key.id}`, {
        headers: auth(customer.accessToken),
      });
      expect(res.status(), await res.text()).toBe(200);
      expect(
        await payload<unknown[]>(res),
        'another customer message was reachable through the apiKeyId filter',
      ).toEqual([]);
    });

    test('a repeated scalar parameter is refused rather than half-read', async ({
      request,
    }) => {
      // Express turns a repeated key into an array. Whichever element the
      // server picked would be arbitrary, so neither may be picked.
      const status = await request.get(
        '/messages?status=delivered&status=failed',
        {
          headers: auth(customer.accessToken),
        },
      );
      expect(status.status(), await status.text()).toBe(400);

      const page = await request.get('/messages?page=1&page=2', {
        headers: auth(customer.accessToken),
      });
      expect(page.status(), await page.text()).toBe(400);
    });

    test('an unknown query parameter is ignored rather than rejected', async ({
      request,
    }) => {
      // forbidNonWhitelisted is deliberately off in main.ts: only `whitelist`
      // is set, so extras are stripped. A client appending its own tracking
      // parameter must still get its list, and must get the same list.
      await seedDeliveredMessage(customer.id, { costAmount: 0.25 });

      const clean = await request.get('/messages', {
        headers: auth(customer.accessToken),
      });
      const noisy = await request.get(
        '/messages?utm_source=email&admin=true&userId=00000000-0000-4000-8000-000000000000',
        { headers: auth(customer.accessToken) },
      );

      expect(noisy.status(), await noisy.text()).toBe(200);
      expect((await payload<{ id: string }[]>(noisy)).map((r) => r.id)).toEqual(
        (await payload<{ id: string }[]>(clean)).map((r) => r.id),
      );
    });

    test('the page-size cap and the offset ceiling bite exactly at their limit', async ({
      request,
    }) => {
      // MAX_PAGE_SIZE is 100 and MAX_OFFSET is 50,000. Both are off-by-one
      // prone, and the offset ceiling is the one that keeps a scraper from
      // pinning a database core, so the boundary is worth pinning.
      const atCap = await request.get('/messages?limit=100', {
        headers: auth(customer.accessToken),
      });
      expect(atCap.status(), await atCap.text()).toBe(200);

      const overCap = await request.get('/messages?limit=101', {
        headers: auth(customer.accessToken),
      });
      expect(overCap.status(), await overCap.text()).toBe(400);

      // (501 - 1) * 100 = 50,000 — the last offset still allowed.
      const atCeiling = await request.get('/messages?page=501&limit=100', {
        headers: auth(customer.accessToken),
      });
      expect(atCeiling.status(), await atCeiling.text()).toBe(200);

      const overCeiling = await request.get('/messages?page=502&limit=100', {
        headers: auth(customer.accessToken),
      });
      expect(overCeiling.status(), await overCeiling.text()).toBe(400);
      expect((await errorOf(overCeiling)).code).toBe('INVALID_INPUT');
    });

    test('a fractional or non-finite page is refused', async ({ request }) => {
      // Number('1e999') is Infinity and Number('NaN') is NaN — both survive the
      // coercion the DTO does and are only stopped by @IsInt.
      for (const page of ['1.5', '1e999', 'NaN', '2,3']) {
        const res = await request.get(
          `/messages?page=${encodeURIComponent(page)}`,
          {
            headers: auth(customer.accessToken),
          },
        );
        expect(res.status(), `page=${page} was accepted`).toBe(400);
      }
    });

    test('skipping the count reports an unknown total instead of a wrong one', async ({
      request,
    }) => {
      for (let i = 0; i < 5; i += 1) {
        await seedDeliveredMessage(customer.id, {
          costAmount: 0.25,
          updatedAt: new Date(Date.now() - i * 60_000),
        });
      }

      const first = await request.get('/messages?limit=2&withCount=false', {
        headers: auth(customer.accessToken),
      });
      const firstBody = (await first.json()) as {
        data: unknown[];
        pagination: {
          totalItems: number;
          totalPages: number;
          hasNextPage: boolean;
          hasPreviousPage: boolean;
        };
      };
      expect(firstBody.data.length).toBe(2);
      // -1 is the sentinel for "not counted". Reporting 0 here would make a
      // pager render "no results" over a full page of them.
      expect(firstBody.pagination.totalItems).toBe(-1);
      expect(firstBody.pagination.totalPages).toBe(-1);
      expect(firstBody.pagination.hasNextPage).toBe(true);
      expect(firstBody.pagination.hasPreviousPage).toBe(false);

      // A short page is how "no more rows" is inferred without a count.
      const last = await request.get(
        '/messages?page=3&limit=2&withCount=false',
        {
          headers: auth(customer.accessToken),
        },
      );
      const lastBody = (await last.json()) as {
        data: unknown[];
        pagination: { hasNextPage: boolean; hasPreviousPage: boolean };
      };
      expect(lastBody.data.length).toBe(1);
      expect(lastBody.pagination.hasNextPage).toBe(false);
      expect(lastBody.pagination.hasPreviousPage).toBe(true);

      const nonsense = await request.get('/messages?withCount=maybe', {
        headers: auth(customer.accessToken),
      });
      expect(nonsense.status(), await nonsense.text()).toBe(400);
    });

    test('a sort direction the API does not know falls back rather than reaching SQL', async ({
      request,
    }) => {
      // sortOrder is only @IsString — the allowlisting happens in
      // normalizeSortOrder, which answers DESC to anything that is not "ASC".
      // So this must behave exactly like the default, not like an injection.
      for (let i = 0; i < 3; i += 1) {
        await seedDeliveredMessage(customer.id, {
          costAmount: 0.25,
          updatedAt: new Date(Date.now() - i * 60_000),
        });
      }

      const baseline = await request.get('/messages?sortOrder=DESC', {
        headers: auth(customer.accessToken),
      });
      const injected = await request.get(
        `/messages?sortOrder=${encodeURIComponent('DESC; DROP TABLE users --')}`,
        { headers: auth(customer.accessToken) },
      );

      expect(injected.status(), await injected.text()).toBe(200);
      expect(
        (await payload<{ id: string }[]>(injected)).map((r) => r.id),
      ).toEqual((await payload<{ id: string }[]>(baseline)).map((r) => r.id));

      const [{ count }] = await sql<{ count: string }>(
        `SELECT COUNT(*)::int AS count FROM "users"`,
      );
      expect(Number(count)).toBeGreaterThan(0);
    });

    test('cursor pages are owner-scoped, not just page-based ones', async ({
      request,
    }) => {
      // Offset and cursor modes are two different service methods; they share a
      // filter builder today, and this is what stops them diverging.
      const mine = await seedDeliveredMessage(customer.id, {
        costAmount: 0.25,
      });

      const other = await createCustomer(request);
      await onboardCustomer(other.id);
      await seedDeliveredMessage(other.id, { costAmount: 0.25 });
      await seedDeliveredMessage(other.id, { costAmount: 0.25 });

      const res = await request.get('/messages?cursor=&limit=50', {
        headers: auth(customer.accessToken),
      });
      expect(res.status(), await res.text()).toBe(200);

      const rows = await payload<{ id: string }[]>(res);
      expect(rows.map((r) => r.id)).toEqual([mine]);
    });

    test('cursor mode refuses an ascending sort outright', async ({
      request,
    }) => {
      // sortOrder is always set (it defaults to DESC), so this branch has to
      // test for the ASC value rather than for presence — an earlier version
      // tested for undefined and rejected every cursor request ever made.
      const res = await request.get('/messages?cursor=&sortOrder=ASC', {
        headers: auth(customer.accessToken),
      });
      expect(res.status(), await res.text()).toBe(400);

      const defaulted = await request.get('/messages?cursor=&sortOrder=DESC', {
        headers: auth(customer.accessToken),
      });
      expect(defaulted.status(), await defaulted.text()).toBe(200);
    });

    test('the list never carries provider-side detail', async ({ request }) => {
      await seedProviderMessage(customer.id, {
        providerMsgId: 'console_leak_check',
      });

      for (const path of ['/messages', '/messages?cursor=']) {
        const res = await request.get(path, {
          headers: auth(customer.accessToken),
        });
        expect(res.status(), await res.text()).toBe(200);

        const rows = await payload<Record<string, unknown>[]>(res);
        expect(rows.length, path).toBe(1);
        expectNoProviderDetail(rows[0]);
        // And the fields the customer is entitled to are still there.
        expect(rows[0]).toHaveProperty('phoneNumber');
        expect(rows[0]).toHaveProperty('costAmount');
      }
    });
  });
});
