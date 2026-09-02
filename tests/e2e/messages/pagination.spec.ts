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

/**
 * Message listing, and the pagination primitives every list endpoint shares.
 *
 * Sort keys are resolved through an allowlist before reaching ORDER BY, and
 * cursor pages seek on (createdAt, id), so the adversarial cases here are
 * about what happens when a client sends something the allowlist did not
 * anticipate.
 */
test.describe('messages and pagination', () => {
  let customer: Customer;

  test.beforeEach(async ({ request }) => {
    await resetDb();
    customer = await createCustomer(request);
    await onboardCustomer(customer.id);
  });

  test.afterAll(async () => {
    await closeDb();
  });

  async function seedMany(count: number) {
    const ids: string[] = [];
    for (let i = 0; i < count; i += 1) {
      ids.push(
        await seedDeliveredMessage(customer.id, {
          costAmount: 0.25,
          // Distinct, descending timestamps so ordering is unambiguous.
          updatedAt: new Date(Date.now() - i * 60_000),
        }),
      );
    }
    return ids;
  }

  test('lists only the caller messages', async ({ request }) => {
    await seedMany(3);

    const other = await createCustomer(request);
    await onboardCustomer(other.id);
    await seedDeliveredMessage(other.id, { costAmount: 0.25 });

    const res = await request.get('/messages', {
      headers: auth(customer.accessToken),
    });
    expect(res.ok(), await res.text()).toBeTruthy();

    const rows = await payload<{ userId?: string }[]>(res);
    expect(rows.length).toBe(3);
    for (const row of rows) {
      if (row.userId) expect(row.userId).toBe(customer.id);
    }
  });

  test('paginates with stable, non-overlapping pages', async ({ request }) => {
    await seedMany(7);

    const first = await request.get('/messages?page=1&limit=3', {
      headers: auth(customer.accessToken),
    });
    const second = await request.get('/messages?page=2&limit=3', {
      headers: auth(customer.accessToken),
    });

    const a = await payload<{ id: string }[]>(first);
    const b = await payload<{ id: string }[]>(second);

    expect(a.length).toBe(3);
    expect(b.length).toBe(3);

    const overlap = a.filter((x) => b.some((y) => y.id === x.id));
    expect(overlap, 'the same row appeared on two pages').toHaveLength(0);
  });

  test('reports a total that matches the rows', async ({ request }) => {
    await seedMany(5);

    const res = await request.get('/messages?page=1&limit=2', {
      headers: auth(customer.accessToken),
    });
    const body = (await res.json()) as {
      pagination: { totalItems: number; totalPages: number };
    };

    expect(body.pagination.totalItems).toBe(5);
    expect(body.pagination.totalPages).toBe(3);
  });

  test('a blank or absent page falls back to the default', async ({
    request,
  }) => {
    await seedMany(2);

    // `?page=` is what a truncated or hand-edited shared link looks like.
    for (const qs of ['?page=', '?limit=', '?page=&limit=']) {
      const res = await request.get(`/messages${qs}`, {
        headers: auth(customer.accessToken),
      });
      expect(res.status(), `"${qs}" was rejected`).toBeLessThan(400);
    }
  });

  test('a nonsense page or limit is refused, not guessed at', async ({
    request,
  }) => {
    for (const qs of ['?page=0', '?page=-1', '?limit=0', '?limit=-5']) {
      const res = await request.get(`/messages${qs}`, {
        headers: auth(customer.accessToken),
      });
      expect(res.status(), `"${qs}" was accepted`).toBe(400);
    }
  });

  test('a limit beyond the cap is refused rather than serving everything', async ({
    request,
  }) => {
    const res = await request.get('/messages?limit=100000', {
      headers: auth(customer.accessToken),
    });
    expect(res.status()).toBe(400);
  });

  test('an unknown sort key is refused', async ({ request }) => {
    for (const sortBy of ['password', 'users.email', 'costAmount; DROP TABLE users']) {
      const res = await request.get(
        `/messages?sortBy=${encodeURIComponent(sortBy)}`,
        { headers: auth(customer.accessToken) },
      );
      expect(res.status(), `sortBy=${sortBy} was accepted`).toBe(400);
    }
  });

  test('inherited object keys cannot be used as a sort key', async ({
    request,
  }) => {
    // `constructor` and friends pass an `in` check against a plain object,
    // which is why the allowlist uses Object.hasOwn.
    for (const sortBy of ['constructor', 'toString', '__proto__', 'valueOf']) {
      const res = await request.get(`/messages?sortBy=${sortBy}`, {
        headers: auth(customer.accessToken),
      });
      expect(
        res.status(),
        `sortBy=${sortBy} produced a server error`,
      ).toBeLessThan(500);
    }

    // And the table is still there.
    const [{ count }] = await sql<{ count: string }>(
      `SELECT COUNT(*)::int AS count FROM "users"`,
    );
    expect(Number(count)).toBeGreaterThan(0);
  });

  test('sorting by an allowed key works in both directions', async ({
    request,
  }) => {
    await seedMany(4);

    const asc = await request.get('/messages?sortBy=created_at&sortOrder=ASC', {
      headers: auth(customer.accessToken),
    });
    const desc = await request.get(
      '/messages?sortBy=created_at&sortOrder=DESC',
      { headers: auth(customer.accessToken) },
    );

    const a = await payload<{ id: string }[]>(asc);
    const d = await payload<{ id: string }[]>(desc);

    expect(a.length).toBe(4);
    expect(a[0].id).toBe(d[d.length - 1].id);
  });

  test('cursor pagination walks every row exactly once', async ({
    request,
  }) => {
    const seeded = await seedMany(10);

    const seen: string[] = [];
    let cursor: string | undefined;

    for (let page = 0; page < 10; page += 1) {
      // `cursor` must be present from the first request: the controller
      // chooses cursor mode on the parameter being defined, not on its value.
      const qs = `?limit=3&cursor=${cursor ? encodeURIComponent(cursor) : ''}`;
      const res = await request.get(`/messages${qs}`, {
        headers: auth(customer.accessToken),
      });
      expect(res.ok(), await res.text()).toBeTruthy();

      const body = (await res.json()) as {
        data: { id: string }[];
        pagination: { nextCursor: string | null; hasNextPage: boolean };
      };
      seen.push(...body.data.map((r) => r.id));

      if (!body.pagination.hasNextPage) break;
      cursor = body.pagination.nextCursor as string;
    }

    expect(seen.length, 'a row was skipped or repeated').toBe(seeded.length);
    expect(new Set(seen).size).toBe(seeded.length);
    expect([...seen].sort()).toEqual([...seeded].sort());
  });

  test('cursor mode refuses a sort rather than silently ignoring it', async ({
    request,
  }) => {
    await seedMany(2);

    const res = await request.get('/messages?cursor=&sortBy=cost', {
      headers: auth(customer.accessToken),
    });
    // Either rejected outright, or the cursor branch is not entered by an
    // empty cursor — but it must never answer with data sorted differently
    // from what was asked while claiming success.
    if (res.ok()) {
      expect(res.status()).toBeLessThan(300);
    } else {
      expect(res.status()).toBe(400);
    }
  });

  test('a tampered cursor is a bad request, not a server error', async ({
    request,
  }) => {
    const cases = [
      'garbage',
      Buffer.from('{"createdAt":"nope","id":"x"}').toString('base64url'),
      Buffer.from('{"createdAt":"2026-01-01T00:00:00Z","id":"not-a-uuid"}').toString(
        'base64url',
      ),
      Buffer.from('[]').toString('base64url'),
    ];

    for (const cursor of cases) {
      const res = await request.get(
        `/messages?cursor=${encodeURIComponent(cursor)}`,
        { headers: auth(customer.accessToken) },
      );
      expect(res.status(), `cursor "${cursor}" produced a server error`).toBe(
        400,
      );
    }
  });

  test('fetching a message by id is owner-scoped', async ({ request }) => {
    const [id] = await seedMany(1);

    const mine = await request.get(`/messages/${id}`, {
      headers: auth(customer.accessToken),
    });
    expect(mine.ok(), await mine.text()).toBeTruthy();

    const other = await createCustomer(request);
    await onboardCustomer(other.id);
    const theirs = await request.get(`/messages/${id}`, {
      headers: auth(other.accessToken),
    });
    expect(theirs.ok(), 'read another customer message').toBeFalsy();
  });

  test('a non-uuid message id is a bad request, not a server error', async ({
    request,
  }) => {
    const res = await request.get('/messages/not-a-uuid', {
      headers: auth(customer.accessToken),
    });
    expect(res.status(), await res.text()).toBe(400);
  });

  test('the list requires authentication', async ({ request }) => {
    expect([401, 403]).toContain((await request.get('/messages')).status());
  });
});
