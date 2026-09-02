import { test, expect } from '@playwright/test';
import { resetDb, closeDb, sql } from '../helpers/db.js';
import {
  createAdmin,
  createPartner,
  seedCustomer,
  seedDeliveredMessage,
  seedReferral,
  updateSettings,
  runAccrual,
  auth,
  payload,
  Customer,
  Partner,
} from '../helpers/actors.js';
import { ABSENT_UUID, errorOf, meta } from './edge-helpers.js';

/**
 * The seams of the partner-facing affiliate controller, after the rest of
 * affiliate/ and platform/partner-session have covered the flows themselves.
 *
 * Nothing here re-asserts a happy path. What is left once accrual, payouts,
 * remediation and attribution are pinned down is the edge: identifiers that
 * belong to somebody else or to nobody, enum values borrowed from a
 * neighbouring enum, and numbers at their bounds.
 */

test.describe('partner portal edge cases', () => {
  let admin: Customer;
  let partner: Partner;

  test.beforeEach(async ({ request }) => {
    await resetDb();
    admin = await createAdmin(request);
    partner = await createPartner(request);
  });

  test.afterAll(async () => {
    await closeDb();
  });

  test('a payout id that is malformed and one that is merely missing answer differently', async ({
    request,
  }) => {
    // Both are "you cannot have this payout", but a client can only act on the
    // difference: a 400 means the link is corrupt, a 404 means the settlement
    // is gone. Collapsing them would also mean the id reached Postgres as a
    // uuid cast error, which is a 500.
    const malformed = await request.get('/partner/payouts/not-a-uuid', {
      headers: auth(partner.accessToken),
    });
    expect(malformed.status(), await malformed.text()).toBe(400);
    expect((await errorOf(malformed)).code).toBe('INVALID_INPUT');

    const missing = await request.get(`/partner/payouts/${ABSENT_UUID}`, {
      headers: auth(partner.accessToken),
    });
    expect(missing.status(), await missing.text()).toBe(404);
    expect((await errorOf(missing)).code).toBe('NOT_FOUND');
  });

  test("one partner's referrals stay invisible to another, whatever the query string says", async ({
    request,
  }) => {
    // The referral list is the one partner-facing list that does not go through
    // paginateQueryBuilder — it hand-rolls its own query — so the scoping it
    // applies is worth asserting separately from the commission list that
    // affiliate/authorization covers.
    const customer = await seedCustomer();
    await seedReferral(partner.id, customer.id, partner.referralCode);

    const other = await createPartner(request);

    const res = await request.get(
      `/partner/referrals?partnerId=${partner.id}&page=1&limit=50`,
      { headers: auth(other.accessToken) },
    );
    expect(res.status(), await res.text()).toBe(200);

    const rows = await payload<unknown[]>(res);
    expect(rows.length, "another partner's referral was listed").toBe(0);
    expect((await meta(res)).totalItems).toBe(0);

    // And the owner still sees it, so the assertion above is not passing
    // because the fixture never landed.
    const mine = await request.get('/partner/referrals', {
      headers: auth(partner.accessToken),
    });
    expect((await payload<unknown[]>(mine)).length).toBe(1);
  });

  test('an admin token cannot rewrite where a partner is paid', async ({
    request,
  }) => {
    // Partner routes are @Public() so the customer-side guards stand down, and
    // PartnerAuthGuard is the only thing admitting the request. An admin token
    // is signed with the customer secret, so it must not verify here — and the
    // stakes are the bank details a payout is sent to.
    await sql(
      `UPDATE "partners" SET "payoutMethod" = 'upi', "upiId" = 'honest@okaxis' WHERE "id" = $1`,
      [partner.id],
    );

    const res = await request.patch('/partner/payout-details', {
      data: { payoutMethod: 'upi', upiId: 'attacker@okaxis' },
      headers: auth(admin.accessToken),
    });
    expect([401, 403], await res.text()).toContain(res.status());

    const [row] = await sql<{ upiId: string }>(
      `SELECT "upiId" FROM "partners" WHERE "id" = $1`,
      [partner.id],
    );
    expect(row.upiId).toBe('honest@okaxis');
  });

  test('the trends window is clamped rather than trusted', async ({
    request,
  }) => {
    // `days` has no DTO behind it — the handler parses and clamps by hand — so
    // every one of these reaches Number() raw. The series is generated with
    // generate_series, so an unclamped value is a query that builds as many
    // rows as the caller asks for.
    const cases: [string, number][] = [
      ['', 30], // absent: the documented default
      ['?days=1', 1],
      ['?days=90', 90],
      ['?days=91', 90], // above the cap
      ['?days=100000', 90],
      ['?days=0', 1], // below the floor
      ['?days=-5', 1],
      ['?days=2.9', 2], // truncated, not rounded
      ['?days=abc', 30], // NaN falls back to the default
      ['?days=%F0%9F%8E%89', 30], // an emoji is NaN too, not a crash
    ];

    for (const [query, expected] of cases) {
      const res = await request.get(`/partner/trends${query}`, {
        headers: auth(partner.accessToken),
      });
      expect(res.status(), `/partner/trends${query}: ${await res.text()}`).toBe(
        200,
      );
      const rows = await payload<{ date: string }[]>(res);
      expect(
        rows.length,
        `/partner/trends${query} returned the wrong span`,
      ).toBe(expected);
    }
  });

  test('a blank days parameter collapses the chart to a single day', async ({
    request,
  }) => {
    // Number('') is 0, which is finite, so it survives the isFinite check and
    // is then clamped up to 1 — a one-day chart from a link somebody truncated
    // when they pasted it. PaginationQueryDto treats exactly this input as
    // absent, on purpose and with a comment saying why; this handler predates
    // that and does not. Asserted as it behaves today rather than as it should,
    // because changing it is a product decision.
    const blank = await request.get('/partner/trends?days=', {
      headers: auth(partner.accessToken),
    });
    expect(blank.status(), await blank.text()).toBe(200);
    expect(
      (await payload<unknown[]>(blank)).length,
      'if this is now 30, the blank-parameter handling was fixed — delete this test',
    ).toBe(1);
  });

  test('logging out twice leaves the session revoked rather than erroring', async ({
    request,
  }) => {
    // A double-clicked logout, or two tabs closing at once. The second call
    // finds nothing to clear, which must be a no-op and not a 500 from an
    // update against a row already nulled.
    const first = await request.post('/partner/auth/logout', {
      headers: auth(partner.accessToken),
    });
    expect(first.status(), await first.text()).toBe(201);

    const second = await request.post('/partner/auth/logout', {
      headers: auth(partner.accessToken),
    });
    expect(second.status(), await second.text()).toBe(201);

    const [row] = await sql<{ refreshTokenHash: string | null }>(
      `SELECT "refreshTokenHash" FROM "partners" WHERE "id" = $1`,
      [partner.id],
    );
    expect(row.refreshTokenHash).toBeNull();
  });

  test('a partner parked on the retired pending status is handed a token that works nowhere', async ({
    request,
  }) => {
    // PENDING was retired when approval was removed, but UpdatePartnerStatusDto
    // still validates against the whole enum, so an admin can put a partner
    // back into it. The two halves of the auth stack then disagree:
    // assertUsable only refuses REJECTED and SUSPENDED, so login succeeds — but
    // PartnerJwtStrategy requires ACTIVE, so the token it just issued is
    // refused by every route. The partner sees a successful sign-in followed by
    // a portal that 401s.
    const set = await request.patch(
      `/admin/affiliate/partners/${partner.id}/status`,
      { data: { status: 'pending' }, headers: auth(admin.accessToken) },
    );
    expect(set.status(), await set.text()).toBe(200);

    const login = await request.post('/partner/auth/login', {
      data: { email: partner.email, password: partner.password },
    });
    expect(
      login.status(),
      'login refused a pending partner — the two gates now agree, revisit this test',
    ).toBe(201);

    const token = (await payload<{ accessToken: string }>(login)).accessToken;
    const me = await request.get('/partner/auth/me', { headers: auth(token) });
    expect(me.status(), 'a freshly issued token was accepted').toBe(401);
  });

  test("an accrued commission appears in its owner's ledger and in nobody else's", async ({
    request,
  }) => {
    // The scoping test in authorization.spec.ts never seeds a commission, so
    // its partnerId loop is vacuous — this is the populated version. One real
    // accrual: a referred customer with a delivered ₹10 OTP at the default 10
    // percent earns exactly ₹1.
    await updateSettings(request, admin.accessToken, { isEnabled: true });
    const customer = await seedCustomer();
    await seedReferral(partner.id, customer.id, partner.referralCode);
    await seedDeliveredMessage(customer.id, { costAmount: 10 });
    await runAccrual(request, admin.accessToken);

    const res = await request.get('/partner/commissions', {
      headers: auth(partner.accessToken),
    });
    expect(res.status(), await res.text()).toBe(200);

    const rows = await payload<
      {
        partnerId: string;
        userId: string;
        amount: number;
        baseAmount: number;
        status: string;
      }[]
    >(res);
    expect(rows).toHaveLength(1);
    expect(rows[0].partnerId).toBe(partner.id);
    expect(rows[0].userId).toBe(customer.id);
    expect(rows[0].amount).toBe(1);
    expect(rows[0].baseAmount).toBe(10);
    expect(rows[0].status).toBe('accrued');
    expect((await meta(res)).totalItems).toBe(1);

    // The status filter really filters — the row is accrued, so asking for
    // paid must return nothing rather than everything.
    const paidOnly = await request.get('/partner/commissions?status=paid', {
      headers: auth(partner.accessToken),
    });
    expect(await payload<unknown[]>(paidOnly)).toEqual([]);

    // And another partner's ledger stays empty — the assertion the vacuous
    // test believed it was making.
    const other = await createPartner(request);
    const theirs = await request.get('/partner/commissions', {
      headers: auth(other.accessToken),
    });
    expect(await payload<unknown[]>(theirs)).toEqual([]);
    expect((await meta(theirs)).totalItems).toBe(0);
  });

  test('a recorded click and a signup land in the correct day buckets of the trend', async ({
    request,
  }) => {
    // The clamping test above only counts rows, so an all-zero series would
    // pass it forever. Seeded straight into referral_clicks — the aggregated
    // per-day table the query reads — plus one real referral row for today.
    const istDate = (at: Date) =>
      new Date(at.getTime() + 5.5 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const now = new Date();
    const today = istDate(now);
    const twoDaysAgo = istDate(new Date(now.getTime() - 2 * 24 * 3600 * 1000));

    await sql(
      `INSERT INTO "referral_clicks" ("partnerId", "date", "clicks", "uniqueClicks")
       VALUES ($1, $2, 3, 2), ($1, $3, 1, 1)`,
      [partner.id, today, twoDaysAgo],
    );
    const customer = await seedCustomer();
    await seedReferral(partner.id, customer.id, partner.referralCode);

    const res = await request.get('/partner/trends?days=7', {
      headers: auth(partner.accessToken),
    });
    expect(res.status(), await res.text()).toBe(200);

    const rows = await payload<
      { date: string; clicks: number; signups: number }[]
    >(res);
    expect(rows).toHaveLength(7);
    // generate_series runs oldest-first and ends today.
    expect(rows[rows.length - 1].date).toBe(today);

    const byDate = new Map(rows.map((r) => [r.date, r]));
    expect(byDate.get(today)).toEqual({ date: today, clicks: 3, signups: 1 });
    expect(byDate.get(twoDaysAgo)).toEqual({
      date: twoDaysAgo,
      clicks: 1,
      signups: 0,
    });
    // Every other day is a genuine zero row, not a missing one.
    for (const row of rows) {
      if (row.date !== today && row.date !== twoDaysAgo) {
        expect(row.clicks, row.date).toBe(0);
        expect(row.signups, row.date).toBe(0);
      }
    }

    // The series is the partner's own: a second partner with no traffic sees
    // the same seven days, all zero.
    const other = await createPartner(request);
    const empty = await payload<{ clicks: number; signups: number }[]>(
      await request.get('/partner/trends?days=7', {
        headers: auth(other.accessToken),
      }),
    );
    expect(empty.every((r) => r.clicks === 0 && r.signups === 0)).toBe(true);
  });

  test('each affiliate list validates page and limit at its bounds', async ({
    request,
  }) => {
    const lists: [string, string][] = [
      ['/partner/referrals', partner.accessToken],
      ['/partner/commissions', partner.accessToken],
      ['/partner/payouts', partner.accessToken],
      ['/admin/affiliate/partners', admin.accessToken],
      ['/admin/affiliate/payouts', admin.accessToken],
    ];

    // 100 is MAX_PAGE_SIZE; 101 is the first value past it. A limit above the
    // cap is how one client accidentally exports the whole table.
    const rejected = [
      'page=0',
      'page=-1',
      'page=abc',
      'page=1.5',
      'limit=0',
      'limit=101',
      'limit=-20',
      'withCount=maybe',
    ];

    for (const [path, token] of lists) {
      for (const query of rejected) {
        const res = await request.get(`${path}?${query}`, {
          headers: auth(token),
        });
        expect(res.status(), `${path}?${query} was accepted`).toBe(400);
        expect((await errorOf(res)).code).toBe('VALIDATION_ERROR');
      }

      // The boundary values themselves are legal, and a blank parameter is
      // treated as absent rather than as zero.
      for (const query of ['page=1&limit=100', 'page=&limit=', 'limit=1']) {
        const res = await request.get(`${path}?${query}`, {
          headers: auth(token),
        });
        expect(res.status(), `${path}?${query}: ${await res.text()}`).toBe(200);
      }
    }
  });

  test('every affiliate list rejects a status borrowed from the wrong enum', async ({
    request,
  }) => {
    // Three different status enums live within one screen of each other:
    // referrals are pending/qualified/blocked, commissions are
    // accrued/paid/reversed, payouts are pending/processing/paid/failed/on_hold.
    // A UI wiring the wrong one up must get a 400, not a filter that silently
    // matches nothing — or worse, one that is ignored and returns everything.
    const wrong: [string, string, string][] = [
      ['/partner/commissions', 'pending', partner.accessToken],
      ['/partner/commissions', 'qualified', partner.accessToken],
      ['/partner/referrals', 'accrued', partner.accessToken],
      ['/partner/payouts', 'accrued', partner.accessToken],
      ['/admin/affiliate/payouts', 'reversed', admin.accessToken],
      ['/admin/affiliate/partners', 'paid', admin.accessToken],
    ];

    for (const [path, status, token] of wrong) {
      const res = await request.get(`${path}?status=${status}`, {
        headers: auth(token),
      });
      expect(res.status(), `${path}?status=${status} was accepted`).toBe(400);
    }

    const right: [string, string, string][] = [
      ['/partner/commissions', 'accrued', partner.accessToken],
      ['/partner/referrals', 'pending', partner.accessToken],
      ['/partner/payouts', 'pending', partner.accessToken],
      ['/admin/affiliate/payouts', 'failed', admin.accessToken],
      ['/admin/affiliate/partners', 'active', admin.accessToken],
    ];

    for (const [path, status, token] of right) {
      const res = await request.get(`${path}?status=${status}`, {
        headers: auth(token),
      });
      expect(
        res.status(),
        `${path}?status=${status}: ${await res.text()}`,
      ).toBe(200);
    }
  });

  test('opting out of the count returns the sentinel total, not a wrong one', async ({
    request,
  }) => {
    // withCount is typed as a string precisely because Boolean('false') is
    // true; a boolean-typed field would read `withCount=false` as enabled and
    // the count would come back anyway. -1 is the agreed "unknown", and a
    // client that renders it as a page count would show "page 1 of -1" — which
    // is the point: it must be unmistakable, never a plausible zero.
    const customer = await seedCustomer();
    await seedReferral(partner.id, customer.id, partner.referralCode);

    const off = await request.get('/partner/referrals?withCount=false', {
      headers: auth(partner.accessToken),
    });
    expect(off.status(), await off.text()).toBe(200);
    expect((await payload<unknown[]>(off)).length).toBe(1);

    const withoutCount = await meta(off);
    expect(withoutCount.totalItems).toBe(-1);
    expect(withoutCount.totalPages).toBe(-1);
    // One row against a page of 20 is not a full page, so there is no next one.
    expect(withoutCount.hasNextPage).toBe(false);

    const on = await request.get('/partner/referrals?withCount=true', {
      headers: auth(partner.accessToken),
    });
    expect((await meta(on)).totalItems).toBe(1);
  });

  test('paging past the offset ceiling is refused on the lists that enforce it', async ({
    request,
  }) => {
    // MAX_OFFSET exists so one client looping to export data cannot pin a
    // database core on OFFSET 9999900. Every affiliate list that goes through
    // paginateQueryBuilder inherits the check.
    for (const path of [
      '/partner/commissions',
      '/partner/payouts',
      '/admin/affiliate/partners',
      '/admin/affiliate/payouts',
    ]) {
      const token = path.startsWith('/admin')
        ? admin.accessToken
        : partner.accessToken;
      const res = await request.get(`${path}?page=100000&limit=100`, {
        headers: auth(token),
      });
      expect(res.status(), `${path} paged past the ceiling`).toBe(400);
      expect((await errorOf(res)).message).toContain('Cannot page beyond');
    }

    // /partner/referrals is the odd one out: it builds its own offset/limit
    // instead of calling paginateQueryBuilder, so the ceiling never runs and a
    // deep page is served. Pinned as it behaves today — the fix belongs in
    // src, not here.
    const unguarded = await request.get(
      '/partner/referrals?page=100000&limit=100',
      { headers: auth(partner.accessToken) },
    );
    expect(
      unguarded.status(),
      'if this is now 400, /partner/referrals gained the offset ceiling — delete this half',
    ).toBe(200);
  });
});
