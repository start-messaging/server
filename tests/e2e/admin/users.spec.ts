import { test, expect } from '@playwright/test';
import { resetDb, closeDb, sql } from '../helpers/db.js';
import {
  createAdmin,
  createCustomer,
  createPartner,
  seedCustomer,
  auth,
  payload,
  unique,
  Customer,
} from '../helpers/actors.js';
import { GHOST_ID, errorOf, meta } from './users-kyc-helpers.js';

/**
 * The admin user list and update surface, at its seams.
 *
 * admin/overview.spec.ts establishes that these routes work and that the role check
 * holds. This file is about what happens either side of that: the id that
 * belongs to nobody, and the value one type away from the one the DTO expects.
 */

test.describe('admin user list and update', () => {
  let admin: Customer;
  let customer: Customer;

  test.beforeEach(async ({ request }) => {
    await resetDb();
    admin = await createAdmin(request);
    customer = await createCustomer(request);
  });

  test.afterAll(async () => {
    await closeDb();
  });

  test('a customer, a partner and an anonymous caller are turned away from every user and KYC route', async ({
    request,
  }) => {
    const partner = await createPartner(request);

    // Every route in scope, including the ones that take an id — a route
    // guarded only for the collection but open on the item is the classic way
    // an admin surface leaks.
    const routes: [string, string][] = [
      ['GET', '/admin/users'],
      ['PATCH', `/admin/users/${customer.id}`],
      ['GET', '/admin/kyc'],
      ['GET', `/admin/kyc/${customer.id}`],
      ['PATCH', `/admin/kyc/${customer.id}`],
      ['GET', `/admin/kyc/${customer.id}/document`],
      ['GET', `/admin/users/${customer.id}/overview`],
      ['GET', `/admin/users/${customer.id}/messages`],
      ['GET', '/admin/messages'],
      ['GET', `/admin/users/${customer.id}/transactions`],
      ['GET', `/admin/users/${customer.id}/api-keys`],
    ];

    for (const [method, path] of routes) {
      // No credentials at all: the auth guard answers before the role guard.
      const anon = await request.fetch(path, { method });
      expect(anon.status(), `${method} ${path} anonymous`).toBe(401);
      expect((await errorOf(anon)).code).toBe('UNAUTHORIZED');

      // A real session for the wrong role. The customer owns the id in the
      // path, which is exactly the case where a naive ownership check would
      // let them through.
      const asCustomer = await request.fetch(path, {
        method,
        headers: auth(customer.accessToken),
      });
      expect(asCustomer.status(), `${method} ${path} as customer`).toBe(403);
      expect((await errorOf(asCustomer)).code).toBe('FORBIDDEN');

      // A partner token is signed with PARTNER_JWT_SECRET, so it is not a
      // weaker session on this API — it is not a session at all.
      const asPartner = await request.fetch(path, {
        method,
        headers: auth(partner.accessToken),
      });
      expect(asPartner.status(), `${method} ${path} as partner`).toBe(401);
    }
  });

  test('a token edited to claim the admin role is refused', async ({
    request,
  }) => {
    // Re-signing is impossible without the secret, so the attack is to keep
    // the original signature and swap the claims. If the strategy ever read
    // the payload before verifying, this is what would walk in.
    const [header, body, signature] = customer.accessToken.split('.');
    const claims = JSON.parse(
      Buffer.from(body, 'base64url').toString('utf8'),
    ) as Record<string, unknown>;
    claims.role = 'admin';
    const forgedPayload = Buffer.from(JSON.stringify(claims)).toString(
      'base64url',
    );

    const noneHeader = Buffer.from(
      JSON.stringify({ alg: 'none', typ: 'JWT' }),
    ).toString('base64url');

    const tokens: [string, string][] = [
      [
        'role swapped, original signature',
        `${header}.${forgedPayload}.${signature}`,
      ],
      ['alg none, no signature', `${noneHeader}.${forgedPayload}.`],
      ['signature truncated', `${header}.${body}.${signature.slice(0, -4)}`],
      ['not a jwt', 'not.a.jwt'],
      ['empty', ''],
    ];

    for (const [what, token] of tokens) {
      const res = await request.get('/admin/kyc', {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(res.status(), `token (${what}) was accepted`).toBe(401);
    }
  });

  test('an id that is not a uuid is refused before any lookup happens', async ({
    request,
  }) => {
    const badIds = [
      'not-a-uuid',
      '123',
      // One character short of a real UUID — the shape a truncated copy-paste
      // takes, and the one a loose regex lets through.
      '00000000-0000-4000-8000-00000000000',
      "1' OR '1'='1",
      // A real UUID with a trailing space, which is what a copy out of a
      // spreadsheet carries. Trimming it server-side would be a kindness that
      // makes two different strings mean the same row.
      `${GHOST_ID} `,
    ];

    const paths = (id: string): [string, string][] => [
      ['PATCH', `/admin/users/${id}`],
      ['GET', `/admin/kyc/${id}`],
      ['PATCH', `/admin/kyc/${id}`],
      ['GET', `/admin/kyc/${id}/document`],
      ['GET', `/admin/users/${id}/overview`],
      ['GET', `/admin/users/${id}/messages`],
      ['GET', `/admin/users/${id}/transactions`],
      ['GET', `/admin/users/${id}/api-keys`],
    ];

    for (const id of badIds) {
      for (const [method, path] of paths(encodeURI(id))) {
        const res = await request.fetch(path, {
          method,
          headers: auth(admin.accessToken),
          // A valid body throughout, so a 400 can only be about the id.
          data:
            method === 'PATCH'
              ? { isActive: true, action: 'approve' }
              : undefined,
        });
        expect(res.status(), `${method} ${path}`).toBe(400);
        // ParseUUIDPipe raises a plain BadRequestException with a string
        // message, which the filter maps to INVALID_INPUT. Body validation
        // failures arrive as an array and map to VALIDATION_ERROR — the two
        // are worth keeping apart, because only one of them is the client's
        // routing that is wrong.
        expect((await errorOf(res)).code, `${method} ${path}`).toBe(
          'INVALID_INPUT',
        );
      }
    }
  });

  test('an unknown user id 404s on both writes but reads back as a null record', async ({
    request,
  }) => {
    const before = await sql<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM "users"`,
    );

    const patched = await request.patch(`/admin/users/${GHOST_ID}`, {
      data: { isActive: false },
      headers: auth(admin.accessToken),
    });
    expect(patched.status(), await patched.text()).toBe(404);
    expect((await errorOf(patched)).code).toBe('NOT_FOUND');

    const reviewed = await request.patch(`/admin/kyc/${GHOST_ID}`, {
      data: { action: 'approve' },
      headers: auth(admin.accessToken),
    });
    expect(reviewed.status(), await reviewed.text()).toBe(404);
    expect((await errorOf(reviewed)).code).toBe('NOT_FOUND');

    // The read does not agree with either write: getKycDetail returns `null`
    // from the handler, which the interceptor wraps as a 200. A client that
    // trusts the status code renders an empty KYC panel for an id that does
    // not exist. Pinned as-is rather than corrected — see the report.
    const read = await request.get(`/admin/kyc/${GHOST_ID}`, {
      headers: auth(admin.accessToken),
    });
    expect(read.status(), await read.text()).toBe(200);
    expect(await payload(read)).toBeNull();

    // Whatever the status codes, none of it may conjure a row.
    const after = await sql<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM "users"`,
    );
    expect(after[0].count).toBe(before[0].count);
  });

  test('page and limit are validated rather than clamped', async ({
    request,
  }) => {
    const rejected = [
      'page=0',
      'page=-1',
      'page=1.5',
      'page=abc',
      'page=null',
      'limit=0',
      'limit=-5',
      // MAX_PAGE_SIZE is 100; one past it must not silently become 100.
      'limit=101',
      'limit=1e3',
      'withCount=maybe',
      // Express parses a repeated key as an array, Number([...]) is NaN.
      // Silently taking the first or last value would make a crafted link
      // mean something different from what it says.
      'page=1&page=2',
    ];

    for (const query of rejected) {
      const res = await request.get(`/admin/users?${query}`, {
        headers: auth(admin.accessToken),
      });
      expect(res.status(), `?${query} was accepted`).toBe(400);
      expect((await errorOf(res)).code, `?${query}`).toBe('VALIDATION_ERROR');
    }

    // The boundary values themselves are fine.
    for (const query of ['page=1&limit=1', 'limit=100', 'withCount=no']) {
      const res = await request.get(`/admin/users?${query}`, {
        headers: auth(admin.accessToken),
      });
      expect(res.status(), `?${query} was refused: ${await res.text()}`).toBe(
        200,
      );
    }
  });

  test('paging past the offset ceiling is refused as bad input, not as a validation failure', async ({
    request,
  }) => {
    // MAX_OFFSET is 50_000: page 501 at 100 rows lands exactly on it and is
    // allowed, 502 is one row too deep. The distinction matters because the
    // ceiling exists to stop a scraper pinning a database core, and a client
    // that retries on 5xx would keep doing it.
    const allowed = await request.get('/admin/users?page=501&limit=100', {
      headers: auth(admin.accessToken),
    });
    expect(allowed.status(), await allowed.text()).toBe(200);
    expect(await payload<unknown[]>(allowed)).toHaveLength(0);

    const refused = await request.get('/admin/users?page=502&limit=100', {
      headers: auth(admin.accessToken),
    });
    expect(refused.status(), await refused.text()).toBe(400);
    expect((await errorOf(refused)).code).toBe('INVALID_INPUT');
  });

  test('walking the list one page at a time visits every account exactly once', async ({
    request,
  }) => {
    // Seeded rather than registered: /auth/register is throttled to 5/min per
    // IP and this test only needs rows, not sessions.
    await seedCustomer({ email: `pager-1-${unique('p')}@example.com` });
    await seedCustomer({ email: `pager-2-${unique('p')}@example.com` });
    await seedCustomer({ email: `pager-3-${unique('p')}@example.com` });

    const whole = await request.get(
      '/admin/users?sortBy=email&sortOrder=asc&limit=100',
      { headers: auth(admin.accessToken) },
    );
    const expected = (await payload<{ email: string }[]>(whole)).map(
      (u) => u.email,
    );
    expect(expected.length).toBe(5);

    // Without a unique trailing sort key, rows sharing a sort value can shift
    // between requests and be skipped or served twice.
    const walked: string[] = [];
    for (let page = 1; page <= expected.length; page += 1) {
      const res = await request.get(
        `/admin/users?sortBy=email&sortOrder=asc&limit=1&page=${page}`,
        { headers: auth(admin.accessToken) },
      );
      const rows = await payload<{ email: string }[]>(res);
      expect(rows, `page ${page}`).toHaveLength(1);
      walked.push(rows[0].email);
    }

    expect(walked).toEqual(expected);
    expect(new Set(walked).size).toBe(walked.length);
  });

  test('withCount=false is honoured by the KYC queue and silently ignored by the user list', async ({
    request,
  }) => {
    await seedCustomer();
    await seedCustomer();

    // KycFilterQueryDto extends PaginationQueryDto outright, so it carries the
    // shouldCount getter and the count query really is skipped: -1 is
    // COUNT_SKIPPED, not a total.
    const kyc = await request.get('/admin/kyc?withCount=false&limit=1', {
      headers: auth(admin.accessToken),
    });
    expect(kyc.status(), await kyc.text()).toBe(200);
    const kycMeta = await meta(kyc);
    expect(kycMeta.totalItems).toBe(-1);
    expect(kycMeta.totalPages).toBe(-1);

    // UserFilterQueryDto is built with OmitType, which copies field
    // initializers and validation metadata but does not extend the class — so
    // the prototype getter is gone and `query.shouldCount` is undefined at
    // runtime, while the TypeScript type still claims it exists. The parameter
    // default in findAll then turns it back on. The flag validates, is
    // accepted, and does nothing. Pinned as current behaviour; reported.
    const users = await request.get('/admin/users?withCount=false&limit=2', {
      headers: auth(admin.accessToken),
    });
    expect(users.status(), await users.text()).toBe(200);
    const usersMeta = await meta(users);
    expect(
      usersMeta.totalItems,
      'withCount=false now reaches the user list — check the report',
    ).toBe(4);
    expect(usersMeta.totalPages).toBe(2);
    expect(usersMeta.hasNextPage).toBe(true);
    expect(usersMeta.hasPreviousPage).toBe(false);
  });

  test('an unknown kyc status is refused while an unknown account status is silently ignored', async ({
    request,
  }) => {
    const badEnum = await request.get('/admin/users?kycStatus=probably', {
      headers: auth(admin.accessToken),
    });
    expect(badEnum.status(), await badEnum.text()).toBe(400);
    expect((await errorOf(badEnum)).code).toBe('VALIDATION_ERROR');

    // `status` is a bare @IsString, and findAll only understands 'active' and
    // 'suspended'. Anything else is accepted and then does nothing, so an
    // operator filtering for "inactive" is shown the whole customer base and
    // has no way to tell. Pinned as current behaviour — see the report.
    const ignored = await request.get('/admin/users?status=inactive', {
      headers: auth(admin.accessToken),
    });
    expect(ignored.status(), await ignored.text()).toBe(200);
    expect((await meta(ignored)).totalItems).toBe(2);

    // The two spellings it does understand really do filter.
    await request.patch(`/admin/users/${customer.id}`, {
      data: { isActive: false },
      headers: auth(admin.accessToken),
    });
    const suspended = await request.get('/admin/users?status=suspended', {
      headers: auth(admin.accessToken),
    });
    const rows = await payload<{ id: string }[]>(suspended);
    expect(rows.map((u) => u.id)).toEqual([customer.id]);
  });

  test('sort direction casing is accepted by the KYC queue and refused by the user list', async ({
    request,
  }) => {
    // Both lists are rendered by the same admin panel from the same sort
    // control, but UserFilterQueryDto allows only lowercase while
    // KycFilterQueryDto allows both cases. Pinned because it is a live trap:
    // the panel sending 'DESC' gets a 400 on one tab and a page on the other.
    const users = await request.get('/admin/users?sortOrder=DESC', {
      headers: auth(admin.accessToken),
    });
    expect(users.status(), await users.text()).toBe(400);
    expect((await errorOf(users)).code).toBe('VALIDATION_ERROR');

    const kyc = await request.get('/admin/kyc?sortOrder=DESC', {
      headers: auth(admin.accessToken),
    });
    expect(kyc.status(), await kyc.text()).toBe(200);

    // The drilldowns inherit the base DTO, where sortOrder is a bare string:
    // an unrecognised direction is not refused, it silently means DESC.
    const transactions = await request.get(
      `/admin/users/${customer.id}/transactions?sortOrder=sideways`,
      { headers: auth(admin.accessToken) },
    );
    expect(transactions.status(), await transactions.text()).toBe(200);
  });

  test('an unknown or injected sort column never reaches the query', async ({
    request,
  }) => {
    const payloads = [
      'passwordHash',
      'email; DROP TABLE users --',
      '(SELECT 1)',
      '__proto__',
      'constructor',
    ];

    for (const sortBy of payloads) {
      for (const path of [
        '/admin/users',
        '/admin/kyc',
        `/admin/users/${customer.id}/transactions`,
        '/admin/messages',
      ]) {
        const res = await request.get(
          `${path}?sortBy=${encodeURIComponent(sortBy)}`,
          { headers: auth(admin.accessToken) },
        );
        expect(res.status(), `${path}?sortBy=${sortBy}`).toBe(400);
        expect((await errorOf(res)).code).toBe('VALIDATION_ERROR');
      }
    }

    // The api-key list inherits the base DTO's untyped sortBy, so the value is
    // accepted and then ignored rather than refused. It never reaches SQL —
    // findByUserPaginated has a fixed ORDER BY — but the asymmetry is real.
    const ignored = await request.get(
      `/admin/users/${customer.id}/api-keys?sortBy=${encodeURIComponent('passwordHash')}`,
      { headers: auth(admin.accessToken) },
    );
    expect(ignored.status(), await ignored.text()).toBe(200);

    const [{ count }] = await sql<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM "users"`,
    );
    expect(count, 'the users table did not survive the sort payloads').toBe(2);
  });

  test('search is parameterised, and an empty or blank search is not a filter', async ({
    request,
  }) => {
    const injection = await request.get(
      `/admin/users?search=${encodeURIComponent("' OR '1'='1")}`,
      { headers: auth(admin.accessToken) },
    );
    expect(injection.status(), await injection.text()).toBe(200);
    // Bound as a parameter, so the quote is just a character nobody's name
    // contains — not a predicate that matches everyone.
    expect(await payload<unknown[]>(injection)).toHaveLength(0);

    // An empty or whitespace-only term is treated as "no filter", because a
    // cleared search box sends `?search=`.
    for (const term of ['', '%20%20']) {
      const res = await request.get(`/admin/users?search=${term}`, {
        headers: auth(admin.accessToken),
      });
      expect(res.status(), `?search=${term}`).toBe(200);
      expect((await meta(res)).totalItems, `?search=${term}`).toBe(2);
    }

    // The KYC queue caps the term at 200 characters; the user list does not
    // cap it at all. 200 in, 201 out.
    const atCap = await request.get(`/admin/kyc?search=${'a'.repeat(200)}`, {
      headers: auth(admin.accessToken),
    });
    expect(atCap.status(), await atCap.text()).toBe(200);

    const overCap = await request.get(`/admin/kyc?search=${'a'.repeat(201)}`, {
      headers: auth(admin.accessToken),
    });
    expect(overCap.status(), await overCap.text()).toBe(400);
    expect((await errorOf(overCap)).code).toBe('VALIDATION_ERROR');
  });

  test('a search term really matches the account that carries it', async ({
    request,
  }) => {
    // The negative half — injection matches nothing, blank matches all — is
    // pinned above, which means a search that silently matched *nothing* would
    // have passed this suite forever. One distinctive marker per searchable
    // column family: the expression concatenates name, email, mobile and the
    // business identifiers, so a hit through each proves none was dropped.
    const marker = unique('needle').replace(/[^a-z0-9]/gi, '');
    const target = await seedCustomer({
      email: `${marker}@example.com`,
    });
    await sql(
      `UPDATE "users"
          SET "firstName" = 'Findable', "businessName" = $2
        WHERE "id" = $1`,
      [target.id, `Traders ${marker}co`],
    );

    // By email fragment, case-insensitively — ILIKE is the contract.
    const byEmail = await request.get(
      `/admin/users?search=${marker.toUpperCase()}`,
      { headers: auth(admin.accessToken) },
    );
    expect(byEmail.status(), await byEmail.text()).toBe(200);
    const emailRows = await payload<{ id: string }[]>(byEmail);
    expect(emailRows.map((u) => u.id)).toEqual([target.id]);

    // By a column other than email, so the concatenation is proven wider than
    // one field.
    const byName = await request.get('/admin/users?search=Findable', {
      headers: auth(admin.accessToken),
    });
    expect((await payload<{ id: string }[]>(byName)).map((u) => u.id)).toEqual([
      target.id,
    ]);

    // And the count agrees with the rows, so pagination over a search cannot
    // claim more matches than it serves.
    expect((await meta(byEmail)).totalItems).toBe(1);
  });

  test('each row carries the wallet balance and tag enrichment the panel renders', async ({
    request,
  }) => {
    // The list's headline enrichment — walletBalance, tags, derivedTags,
    // metrics per row — was never asserted anywhere: the whole second half of
    // the handler could be deleted and the suite stayed green.
    const res = await request.get(`/admin/users?search=${customer.email}`, {
      headers: auth(admin.accessToken),
    });
    expect(res.status(), await res.text()).toBe(200);

    const [row] = await payload<
      {
        id: string;
        walletBalance: number;
        tags: unknown[];
        derivedTags: { kind: string; key: string; label: string }[];
        metrics: {
          balance: number;
          topupCount: number;
          messages30d: number;
          deliveryRate30d: number | null;
        } | null;
      }[]
    >(res);
    expect(row.id).toBe(customer.id);

    // The welcome credit, as a number — not a numeric string, not zero.
    expect(row.walletBalance).toBe(10);

    // No manual tags were assigned, but derived tags are computed, never
    // stored, so a fresh account already carries the "never topped up" fact.
    expect(row.tags).toEqual([]);
    expect(row.derivedTags.map((t) => t.key)).toContain('topup:0');
    expect(row.derivedTags.every((t) => t.kind === 'derived')).toBe(true);

    // Metrics arrive populated: the balance agrees with the wallet column,
    // and no traffic in the window is null delivery — not a broken-looking 0.
    expect(row.metrics).not.toBeNull();
    expect(row.metrics?.balance).toBe(10);
    expect(row.metrics?.topupCount).toBe(0);
    expect(row.metrics?.messages30d).toBe(0);
    expect(row.metrics?.deliveryRate30d).toBeNull();
  });

  test('unknown query and body properties are stripped rather than refused', async ({
    request,
  }) => {
    // The global ValidationPipe runs with whitelist but without
    // forbidNonWhitelisted, so an unrecognised field is dropped in silence.
    // Worth pinning: it is the difference between a typo'd filter returning
    // everything and returning a 400 that says so.
    const listed = await request.get(
      '/admin/users?bogus=1&kyc_status=approved',
      {
        headers: auth(admin.accessToken),
      },
    );
    expect(listed.status(), await listed.text()).toBe(200);
    expect((await meta(listed)).totalItems).toBe(2);

    const patched = await request.patch(`/admin/users/${customer.id}`, {
      data: { nickname: 'x', adminCallnotes: 'wrong case' },
      headers: auth(admin.accessToken),
    });
    expect(patched.status(), await patched.text()).toBe(200);

    const [row] = await sql<{ adminCallNotes: string | null }>(
      `SELECT "adminCallNotes" FROM "users" WHERE "id" = $1`,
      [customer.id],
    );
    expect(row.adminCallNotes).toBeNull();
  });

  test('an empty patch body leaves the account exactly as it was', async ({
    request,
  }) => {
    const seeded = await request.patch(`/admin/users/${customer.id}`, {
      data: { isActive: false, adminCallNotes: 'called about the invoice' },
      headers: auth(admin.accessToken),
    });
    expect(seeded.status(), await seeded.text()).toBe(200);

    // A save button with nothing edited behind it must be a no-op, not a
    // reset to defaults.
    const empty = await request.patch(`/admin/users/${customer.id}`, {
      data: {},
      headers: auth(admin.accessToken),
    });
    expect(empty.status(), await empty.text()).toBe(200);

    const [row] = await sql<{ isActive: boolean; adminCallNotes: string }>(
      `SELECT "isActive", "adminCallNotes" FROM "users" WHERE "id" = $1`,
      [customer.id],
    );
    expect(row.isActive).toBe(false);
    expect(row.adminCallNotes).toBe('called about the invoice');
  });

  test('a string "false" reactivates the account an admin asked to deactivate', async ({
    request,
  }) => {
    await request.patch(`/admin/users/${customer.id}`, {
      data: { isActive: false },
      headers: auth(admin.accessToken),
    });

    // enableImplicitConversion coerces to the reflected type, and
    // Boolean('false') is true — the same trap PaginationQueryDto documents
    // for withCount, except here nothing works around it. A client that sends
    // form values as strings reactivates an account it just suspended.
    // Pinned as current behaviour; reported as a bug.
    const res = await request.patch(`/admin/users/${customer.id}`, {
      data: { isActive: 'false' },
      headers: auth(admin.accessToken),
    });
    expect(res.status(), await res.text()).toBe(200);

    const [afterString] = await sql<{ isActive: boolean }>(
      `SELECT "isActive" FROM "users" WHERE "id" = $1`,
      [customer.id],
    );
    expect(
      afterString.isActive,
      'isActive:"false" no longer coerces to true — check the report',
    ).toBe(true);

    // And the other direction: a number is coerced just as happily.
    const zero = await request.patch(`/admin/users/${customer.id}`, {
      data: { isActive: 0 },
      headers: auth(admin.accessToken),
    });
    expect(zero.status(), await zero.text()).toBe(200);

    const [afterZero] = await sql<{ isActive: boolean }>(
      `SELECT "isActive" FROM "users" WHERE "id" = $1`,
      [customer.id],
    );
    expect(afterZero.isActive).toBe(false);
  });

  test('a null isActive never blanks the flag', async ({ request }) => {
    // @IsOptional() skips validation for null, so null survives the DTO and
    // reaches `UPDATE users SET "isActive" = NULL` against a NOT NULL column.
    // Today that is a 500; whatever it becomes, the stored flag must not move.
    const res = await request.patch(`/admin/users/${customer.id}`, {
      data: { isActive: null },
      headers: auth(admin.accessToken),
    });

    const [row] = await sql<{ isActive: boolean }>(
      `SELECT "isActive" FROM "users" WHERE "id" = $1`,
      [customer.id],
    );
    expect(row.isActive, `PATCH answered ${res.status()}`).toBe(true);
  });

  test('admin call notes keep their exact bytes and stop at ten thousand characters', async ({
    request,
  }) => {
    // Internal notes are pasted from a call log: emoji, non-Latin names and
    // the spacing the operator typed all have to survive the round trip
    // unchanged, because the next operator reads them as evidence.
    const notes = '  Spoke to Ananya (आनन्या) re: GST 🇮🇳 — call back 5pm  ';
    const written = await request.patch(`/admin/users/${customer.id}`, {
      data: { adminCallNotes: notes },
      headers: auth(admin.accessToken),
    });
    expect(written.status(), await written.text()).toBe(200);

    const [row] = await sql<{ adminCallNotes: string }>(
      `SELECT "adminCallNotes" FROM "users" WHERE "id" = $1`,
      [customer.id],
    );
    expect(row.adminCallNotes).toBe(notes);

    const atCap = await request.patch(`/admin/users/${customer.id}`, {
      data: { adminCallNotes: 'x'.repeat(10_000) },
      headers: auth(admin.accessToken),
    });
    expect(atCap.status(), await atCap.text()).toBe(200);

    const overCap = await request.patch(`/admin/users/${customer.id}`, {
      data: { adminCallNotes: 'x'.repeat(10_001) },
      headers: auth(admin.accessToken),
    });
    expect(overCap.status(), await overCap.text()).toBe(400);
    expect((await errorOf(overCap)).code).toBe('VALIDATION_ERROR');

    // The rejected write must not have truncated anything on its way out.
    const [unchanged] = await sql<{ adminCallNotes: string }>(
      `SELECT "adminCallNotes" FROM "users" WHERE "id" = $1`,
      [customer.id],
    );
    expect(unchanged.adminCallNotes).toBe('x'.repeat(10_000));
  });

  test('the last-called timestamp takes an ISO datetime, clears on null and refuses anything else', async ({
    request,
  }) => {
    const when = '2026-03-04T09:30:00.000Z';
    const set = await request.patch(`/admin/users/${customer.id}`, {
      data: { adminLastCalledAt: when },
      headers: auth(admin.accessToken),
    });
    expect(set.status(), await set.text()).toBe(200);

    const [stored] = await sql<{ adminLastCalledAt: Date }>(
      `SELECT "adminLastCalledAt" FROM "users" WHERE "id" = $1`,
      [customer.id],
    );
    expect(new Date(stored.adminLastCalledAt).toISOString()).toBe(when);

    // Documented as "send null to clear", which is a different intent from
    // omitting the field — omitting it must leave the value alone.
    const untouched = await request.patch(`/admin/users/${customer.id}`, {
      data: { adminCallNotes: 'left the timestamp alone' },
      headers: auth(admin.accessToken),
    });
    expect(untouched.status(), await untouched.text()).toBe(200);
    const [kept] = await sql<{ adminLastCalledAt: Date | null }>(
      `SELECT "adminLastCalledAt" FROM "users" WHERE "id" = $1`,
      [customer.id],
    );
    expect(kept.adminLastCalledAt).not.toBeNull();

    const cleared = await request.patch(`/admin/users/${customer.id}`, {
      data: { adminLastCalledAt: null },
      headers: auth(admin.accessToken),
    });
    expect(cleared.status(), await cleared.text()).toBe(200);
    const [empty] = await sql<{ adminLastCalledAt: Date | null }>(
      `SELECT "adminLastCalledAt" FROM "users" WHERE "id" = $1`,
      [customer.id],
    );
    expect(empty.adminLastCalledAt).toBeNull();

    // `2026-03-04 09:30` is deliberately absent: ISO 8601 permits a space
    // separator and @IsDateString accepts it, so it is valid input here.
    for (const bad of ['yesterday', '04/03/2026', 'T09:30:00Z', 1735689600]) {
      const res = await request.patch(`/admin/users/${customer.id}`, {
        data: { adminLastCalledAt: bad },
        headers: auth(admin.accessToken),
      });
      expect(res.status(), `adminLastCalledAt=${String(bad)}`).toBe(400);
      expect((await errorOf(res)).code).toBe('VALIDATION_ERROR');
    }
  });

  test('the user patch cannot approve KYC or move an account to another email', async ({
    request,
  }) => {
    // AdminUpdateUserDto covers three fields. Everything else on the user row
    // — identity, role, and above all the KYC verdict — has its own audited
    // route, and must not be reachable through the general-purpose update.
    const res = await request.patch(`/admin/users/${customer.id}`, {
      data: {
        kycStatus: 'approved',
        hasCompletedOnboarding: true,
        email: 'attacker@example.com',
        mobileVerified: true,
        isActive: true,
      },
      headers: auth(admin.accessToken),
    });
    expect(res.status(), await res.text()).toBe(200);

    const [row] = await sql<{
      kycStatus: string;
      email: string;
      mobileVerified: boolean;
      hasCompletedOnboarding: boolean;
    }>(
      `SELECT "kycStatus", "email", "mobileVerified", "hasCompletedOnboarding"
         FROM "users" WHERE "id" = $1`,
      [customer.id],
    );
    expect(row.kycStatus).toBe('not_submitted');
    expect(row.email).toBe(customer.email.toLowerCase());
    expect(row.mobileVerified).toBe(false);
    expect(row.hasCompletedOnboarding).toBe(false);
  });
});
