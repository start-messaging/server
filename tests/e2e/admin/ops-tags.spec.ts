import { test, expect } from '@playwright/test';
import { resetDb, closeDb, sql } from '../helpers/db.js';
import {
  createAdmin,
  createCustomer,
  onboardCustomer,
  seedCustomer,
  auth,
  payload,
  unique,
  Customer,
} from '../helpers/actors.js';
import {
  NOWHERE,
  FIXTURE,
  WELCOME_CREDIT,
  errorCode,
  errorMessage,
  removeFixtures,
} from './ops-helpers.js';

/**
 * Admin tags: the manual chips an operator hangs on an account, and the derived
 * ones computed from it.
 *
 * admin/overview.spec.ts walks the happy path of these routes. This file goes after
 * the seams instead — the duplicate name in another casing, the id that belongs
 * to someone else, and the soft delete that has to keep the account history.
 */

test.describe('admin ops — tags', () => {
  let admin: Customer;
  let customer: Customer;

  test.beforeEach(async ({ request }) => {
    await resetDb();
    await removeFixtures();
    admin = await createAdmin(request);
    customer = await createCustomer(request);
    await onboardCustomer(customer.id);
  });

  test.afterEach(async () => {
    await removeFixtures();
  });

  test.afterAll(async () => {
    await closeDb();
  });

  async function makeTag(
    request: Parameters<typeof createCustomer>[0],
    name: string,
  ): Promise<{ id: string; name: string }> {
    const res = await request.post('/admin/tags', {
      data: { name },
      headers: auth(admin.accessToken),
    });
    expect(res.status(), await res.text()).toBe(201);
    return payload<{ id: string; name: string }>(res);
  }

  test('a tag name is trimmed, and cannot be duplicated in any casing', async ({
    request,
  }) => {
    // The uniqueness check is LOWER(name) against live rows only, after a trim.
    // Without both halves the picker fills up with "VIP", "vip" and "VIP ".
    const base = unique(`${FIXTURE}tag`);
    const created = await makeTag(request, `  ${base}  `);
    expect(created.name).toBe(base);

    for (const clash of [base, base.toUpperCase(), `  ${base}  `]) {
      const res = await request.post('/admin/tags', {
        data: { name: clash },
        headers: auth(admin.accessToken),
      });
      expect(res.status(), `"${clash}" was allowed alongside "${base}"`).toBe(
        400,
      );
      expect(await errorMessage(res)).toContain('already exists');
    }

    const [{ count }] = await sql<{ count: string }>(
      `SELECT COUNT(*)::int AS count FROM "tags" WHERE LOWER("name") = LOWER($1) AND "deletedAt" IS NULL`,
      [base],
    );
    expect(Number(count)).toBe(1);
  });

  test('tag validation boundaries are enforced', async ({ request }) => {
    for (const data of [
      {},
      { name: null },
      { name: '' },
      { name: 'a' }, // one short of @MinLength(2)
      { name: 'x'.repeat(41) }, // one past @MaxLength(40)
      { name: `${FIXTURE}ok`, colour: 'purple' }, // off-palette
      { name: `${FIXTURE}ok`, colour: '' },
      { name: `${FIXTURE}ok`, description: 'd'.repeat(201) },
      { name: [`${FIXTURE}ok`] },
    ]) {
      const res = await request.post('/admin/tags', {
        data,
        headers: auth(admin.accessToken),
      });
      expect(res.status(), `accepted ${JSON.stringify(data)}`).toBe(400);
    }

    // Exactly at the limits is fine.
    const ok = await request.post('/admin/tags', {
      data: {
        name: `${FIXTURE}${'x'.repeat(40 - FIXTURE.length)}`,
        colour: 'violet',
        description: 'd'.repeat(200),
      },
      headers: auth(admin.accessToken),
    });
    expect(ok.status(), await ok.text()).toBe(201);
  });

  test('two admins creating the same tag at the same moment produce one tag', async ({
    request,
  }) => {
    // The service checks for a clash and then inserts, which is not atomic; the
    // partial unique index UQ_tags_name_live on LOWER(name) is what actually
    // holds the line. One row either way is the invariant this asserts.
    const name = unique(`${FIXTURE}race`);
    const [a, b] = await Promise.all([
      request.post('/admin/tags', {
        data: { name },
        headers: auth(admin.accessToken),
      }),
      request.post('/admin/tags', {
        data: { name },
        headers: auth(admin.accessToken),
      }),
    ]);

    const statuses = [a.status(), b.status()];
    expect(statuses.filter((s) => s === 201).length).toBe(1);

    const [{ count }] = await sql<{ count: string }>(
      `SELECT COUNT(*)::int AS count FROM "tags" WHERE LOWER("name") = LOWER($1) AND "deletedAt" IS NULL`,
      [name],
    );
    expect(Number(count), 'a concurrent duplicate created a second tag').toBe(
      1,
    );

    // What the loser is *told* is deliberately not asserted. When the two
    // requests happen to serialise, the existence check catches the clash and
    // the answer is the same 400 the sequential case gives; when they genuinely
    // interleave, the unique index raises 23505 and a TypeORM QueryFailedError
    // reaches AllExceptionsFilter as a 500. Both outcomes are reachable in one
    // run, so pinning either spelling would only make this test flap. The 500
    // is a real defect — reported in the return payload, not asserted here.
  });

  test('deleting a tag hides it everywhere but keeps the account history', async ({
    request,
  }) => {
    // Soft delete, so a link written months ago still explains itself. The tag
    // must disappear from the customer's chip row and from the picker, while
    // the user_tags row stays where it is.
    const tag = await makeTag(request, unique(`${FIXTURE}tag`));

    const assigned = await request.put(`/admin/users/${customer.id}/tags`, {
      data: { tagIds: [tag.id] },
      headers: auth(admin.accessToken),
    });
    expect(assigned.status(), await assigned.text()).toBe(200);

    const removed = await request.delete(`/admin/tags/${tag.id}`, {
      headers: auth(admin.accessToken),
    });
    expect(removed.status(), await removed.text()).toBe(200);

    const list = await request.get('/admin/tags', {
      headers: auth(admin.accessToken),
    });
    expect(
      (await payload<{ id: string }[]>(list)).map((t) => t.id),
    ).not.toContain(tag.id);

    const summary = await request.get(`/admin/users/${customer.id}/tags`, {
      headers: auth(admin.accessToken),
    });
    expect((await payload<{ manual: unknown[] }>(summary)).manual).toEqual([]);

    const [{ count }] = await sql<{ count: string }>(
      `SELECT COUNT(*)::int AS count FROM "user_tags" WHERE "userId" = $1 AND "tagId" = $2`,
      [customer.id, tag.id],
    );
    expect(Number(count), 'the link row was destroyed with the tag').toBe(1);
  });

  test('deleting an unknown tag is a 404, and deleting a deleted one reports success again', async ({
    request,
  }) => {
    const unknown = await request.delete(`/admin/tags/${NOWHERE}`, {
      headers: auth(admin.accessToken),
    });
    expect(unknown.status(), await unknown.text()).toBe(404);
    expect(await errorCode(unknown)).toBe('NOT_FOUND');

    const malformed = await request.delete('/admin/tags/not-a-uuid', {
      headers: auth(admin.accessToken),
    });
    expect(malformed.status(), await malformed.text()).toBe(400);

    const tag = await makeTag(request, unique(`${FIXTURE}tag`));
    const first = await request.delete(`/admin/tags/${tag.id}`, {
      headers: auth(admin.accessToken),
    });
    expect(first.status(), await first.text()).toBe(200);

    // The soft delete is an UPDATE with no "deletedAt IS NULL" guard, so it
    // matches the already-deleted row and reports one row affected. The second
    // call therefore succeeds and moves the recorded deletion time. Pinned as
    // it behaves today.
    const second = await request.delete(`/admin/tags/${tag.id}`, {
      headers: auth(admin.accessToken),
    });
    expect(second.status(), await second.text()).toBe(200);

    const [row] = await sql<{ deletedAt: Date | null }>(
      `SELECT "deletedAt" FROM "tags" WHERE "id" = $1`,
      [tag.id],
    );
    expect(row.deletedAt).not.toBeNull();
  });

  test('setting tags replaces the whole set rather than merging into it', async ({
    request,
  }) => {
    // The route takes the complete set precisely so two admins editing the same
    // account cannot interleave into a half-applied state.
    const first = await makeTag(request, unique(`${FIXTURE}tag`));
    const second = await makeTag(request, unique(`${FIXTURE}tag`));

    const both = await request.put(`/admin/users/${customer.id}/tags`, {
      // The duplicate is deliberate: deduplication happens before the insert,
      // and without it the composite primary key would reject the whole call.
      data: { tagIds: [first.id, second.id, first.id] },
      headers: auth(admin.accessToken),
    });
    expect(both.status(), await both.text()).toBe(200);
    expect(
      (await payload<{ id: string }[]>(both)).map((t) => t.id).sort(),
    ).toEqual([first.id, second.id].sort());

    const narrowed = await request.put(`/admin/users/${customer.id}/tags`, {
      data: { tagIds: [second.id] },
      headers: auth(admin.accessToken),
    });
    expect(
      (await payload<{ id: string }[]>(narrowed)).map((t) => t.id),
    ).toEqual([second.id]);

    const cleared = await request.put(`/admin/users/${customer.id}/tags`, {
      data: { tagIds: [] },
      headers: auth(admin.accessToken),
    });
    expect(await payload<unknown[]>(cleared)).toEqual([]);

    const [{ count }] = await sql<{ count: string }>(
      `SELECT COUNT(*)::int AS count FROM "user_tags" WHERE "userId" = $1`,
      [customer.id],
    );
    expect(Number(count)).toBe(0);
  });

  test('a rejected tag assignment leaves the existing set untouched', async ({
    request,
  }) => {
    // The existence check runs before the delete-then-insert transaction. If it
    // ever moved inside, a call naming one bad id would wipe the account's tags
    // on its way to failing.
    const live = await makeTag(request, unique(`${FIXTURE}tag`));
    const doomed = await makeTag(request, unique(`${FIXTURE}tag`));
    await request.put(`/admin/users/${customer.id}/tags`, {
      data: { tagIds: [live.id] },
      headers: auth(admin.accessToken),
    });
    await request.delete(`/admin/tags/${doomed.id}`, {
      headers: auth(admin.accessToken),
    });

    for (const tagIds of [
      [NOWHERE], // well-formed uuid, no such tag
      [live.id, NOWHERE],
      [doomed.id], // a soft-deleted tag is not a live tag
    ]) {
      const res = await request.put(`/admin/users/${customer.id}/tags`, {
        data: { tagIds },
        headers: auth(admin.accessToken),
      });
      expect(res.status(), `accepted ${JSON.stringify(tagIds)}`).toBe(400);
      expect(await errorMessage(res)).toContain('do not exist');
    }

    // Shape errors, which never reach the service at all.
    for (const tagIds of [
      undefined,
      null,
      'not-an-array',
      ['not-a-uuid'],
      [123],
      Array.from({ length: 51 }, () => NOWHERE), // one past @ArrayMaxSize(50)
    ]) {
      const res = await request.put(`/admin/users/${customer.id}/tags`, {
        data: { tagIds },
        headers: auth(admin.accessToken),
      });
      expect(res.status(), `accepted ${JSON.stringify(tagIds)}`).toBe(400);
    }

    const still = await request.get(`/admin/users/${customer.id}/tags`, {
      headers: auth(admin.accessToken),
    });
    expect(
      (await payload<{ manual: { id: string }[] }>(still)).manual.map(
        (t) => t.id,
      ),
      'a refused assignment cleared the tags it was refused for',
    ).toEqual([live.id]);
  });

  test('a malformed user id is refused, and an empty set is a no-op for anyone', async ({
    request,
  }) => {
    const tag = await makeTag(request, unique(`${FIXTURE}tag`));

    // ParseUUIDPipe on the parameter, so an unparseable id is a 400 and never
    // reaches the service — not the 404 a missing account would suggest.
    const malformed = await request.put('/admin/users/not-a-uuid/tags', {
      data: { tagIds: [tag.id] },
      headers: auth(admin.accessToken),
    });
    expect(malformed.status(), await malformed.text()).toBe(400);

    // An empty set clears rather than inserts, so there is no foreign key to
    // violate and any well-formed uuid is answered 200 with an empty list —
    // including one nobody owns. Still true: the existence check the route
    // gained runs only when there are tags to insert, precisely so this
    // no-op keeps costing nothing and keeps answering 200.
    const empty = await request.put(`/admin/users/${NOWHERE}/tags`, {
      data: { tagIds: [] },
      headers: auth(admin.accessToken),
    });
    expect(empty.status(), await empty.text()).toBe(200);
    expect(await payload<unknown[]>(empty)).toEqual([]);
  });

  test('tagging an account that does not exist is not a server error', async ({
    request,
  }) => {
    // The route looks the account up before it inserts anything. It used to go
    // straight to a DELETE and an INSERT, and user_tags.userId is a FOREIGN KEY
    // to users, so a well-formed uuid nobody owns raised 23503 — a TypeORM
    // QueryFailedError, not an HttpException, so AllExceptionsFilter answered
    // 500 INTERNAL_ERROR with a database error id in the logs. It is a 404 now.
    // The 23503 is still translated to the same 404 if an account is deleted
    // between the check and the insert, which the check cannot lock against.
    const tag = await makeTag(request, unique(`${FIXTURE}tag`));

    const res = await request.put(`/admin/users/${NOWHERE}/tags`, {
      data: { tagIds: [tag.id] },
      headers: auth(admin.accessToken),
    });
    expect(
      res.status(),
      `tagging a non-existent user answered ${res.status()}: ${await res.text()}`,
    ).toBeLessThan(500);
  });

  test('derived tags are computed from the account, not stored on it', async ({
    request,
  }) => {
    // A brand-new customer is exactly: never topped up, new this week, and
    // holding only the ₹10 welcome credit. Nothing is stored — these come out
    // of the metrics query — so they are the sharpest available check that the
    // query still works.
    const res = await request.get(`/admin/users/${customer.id}/tags`, {
      headers: auth(admin.accessToken),
    });
    expect(res.status(), await res.text()).toBe(200);

    const summary = await payload<{
      manual: unknown[];
      derived: { key: string }[];
      metrics: {
        balance: number;
        topupCount: number;
        deliveryRate30d: number | null;
        messages30d: number;
      };
    }>(res);

    expect(summary.manual).toEqual([]);
    expect(summary.derived.map((d) => d.key).sort()).toEqual([
      'age:new',
      'health:low-balance',
      'topup:0',
    ]);
    expect(summary.metrics.balance).toBe(WELCOME_CREDIT);
    expect(summary.metrics.topupCount).toBe(0);
    // Null rather than 0: a silent account is not a failing one, and colouring
    // it red would bury the accounts that really are broken.
    expect(summary.metrics.deliveryRate30d).toBeNull();
    expect(summary.metrics.messages30d).toBe(0);
  });

  test('reading tags for an account that does not exist answers an empty summary', async ({
    request,
  }) => {
    // No 404 here: the route hands back a well-formed empty envelope for any
    // uuid. The empty `derived` list is the tell — a real account always has at
    // least a tenure and a top-up tag. Pinned as it behaves today.
    const res = await request.get(`/admin/users/${NOWHERE}/tags`, {
      headers: auth(admin.accessToken),
    });
    expect(res.status(), await res.text()).toBe(200);

    const summary = await payload<{
      userId: string;
      manual: unknown[];
      derived: unknown[];
      metrics: { balance: number };
    }>(res);
    expect(summary.userId).toBe(NOWHERE);
    expect(summary.manual).toEqual([]);
    expect(summary.derived).toEqual([]);
    expect(summary.metrics.balance).toBe(0);

    const malformed = await request.get('/admin/users/not-a-uuid/tags', {
      headers: auth(admin.accessToken),
    });
    expect(malformed.status(), await malformed.text()).toBe(400);
  });

  test('a tag applied to one customer never appears on another', async ({
    request,
  }) => {
    const other = await seedCustomer();
    const tag = await makeTag(request, unique(`${FIXTURE}tag`));

    await request.put(`/admin/users/${customer.id}/tags`, {
      data: { tagIds: [tag.id] },
      headers: auth(admin.accessToken),
    });

    const res = await request.get(`/admin/users/${other.id}/tags`, {
      headers: auth(admin.accessToken),
    });
    expect((await payload<{ manual: unknown[] }>(res)).manual).toEqual([]);
  });
});
