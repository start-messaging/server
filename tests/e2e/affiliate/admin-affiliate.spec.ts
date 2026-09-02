import { test, expect, APIRequestContext } from '@playwright/test';
import {
  resetDb,
  closeDb,
  sql,
  partnerTotals,
  readSettings,
} from '../helpers/db.js';
import {
  createAdmin,
  createCustomer,
  createPartner,
  seedCustomer,
  seedReferral,
  seedDeliveredMessage,
  updateSettings,
  runAccrual,
  runPayouts,
  auth,
  payload,
  Customer,
  Partner,
} from '../helpers/actors.js';
import { ABSENT_UUID, errorOf } from './edge-helpers.js';

/**
 * The seams of the admin-facing affiliate controller, after the rest of
 * affiliate/ and platform/partner-session have covered the flows themselves.
 *
 * Nothing here re-asserts a happy path. What is left once accrual, payouts,
 * remediation and attribution are pinned down is the edge: identifiers that
 * belong to somebody else or to nobody, enum values borrowed from a
 * neighbouring enum, numbers at their bounds, and two admins pressing the same
 * button at once.
 */

test.describe('admin affiliate edge cases', () => {
  let admin: Customer;
  let partner: Partner;

  test.beforeEach(async ({ request }) => {
    await resetDb();
    admin = await createAdmin(request);
    partner = await createPartner(request);
    // A flat ₹100 per delivered OTP so every figure below is exact.
    await updateSettings(request, admin.accessToken, {
      isEnabled: true,
      minPaidReferrals: 1,
      minPayoutAmount: 10,
      defaultCommissionType: 'flat',
      defaultCommissionRate: 100,
    });
    await sql(
      `UPDATE "partners" SET "payoutMethod" = 'upi', "upiId" = 'test@upi' WHERE "id" = $1`,
      [partner.id],
    );
  });

  test.afterAll(async () => {
    await closeDb();
  });

  /** One qualified referral earning exactly 100, still accrued. */
  async function earning(request: APIRequestContext) {
    const user = await seedCustomer();
    const referralId = await seedReferral(
      partner.id,
      user.id,
      partner.referralCode,
      'qualified',
    );
    await seedDeliveredMessage(user.id, { costAmount: 1 });
    await runAccrual(request, admin.accessToken);

    const [commission] = await sql<{ id: string }>(
      `SELECT "id" FROM "partner_commissions" WHERE "referralId" = $1`,
      [referralId],
    );
    return { user, referralId, commissionId: commission.id };
  }

  /** Settles that 100 into a pending payout and returns its id. */
  async function raisePayout(request: APIRequestContext): Promise<string> {
    await earning(request);
    const run = await runPayouts(request, admin.accessToken);
    expect(run.payoutsCreated).toBe(1);

    const [row] = await sql<{ id: string }>(
      `SELECT "id" FROM "partner_payouts" WHERE "partnerId" = $1`,
      [partner.id],
    );
    return row.id;
  }

  test('no non-admin can reach a money-moving affiliate route, and none of them move money', async ({
    request,
  }) => {
    // The job triggers are the sharpest ones: accrual writes commissions and
    // the payout run marks them paid. A status assertion alone would not catch
    // a guard that rejects the response after the handler has already run, so
    // the ledger is checked afterwards against a fixture that a successful run
    // would certainly have earned on.
    const user = await seedCustomer();
    await seedReferral(partner.id, user.id, partner.referralCode, 'qualified');
    await seedDeliveredMessage(user.id, { costAmount: 1 });

    const customer = await createCustomer(request);
    const routes: [string, string][] = [
      ['GET', '/admin/affiliate/overview'],
      ['GET', '/admin/affiliate/partners'],
      ['GET', '/admin/affiliate/payouts'],
      ['POST', '/admin/affiliate/jobs/accrual'],
      ['POST', '/admin/affiliate/jobs/payouts'],
      ['POST', '/admin/affiliate/jobs/reconcile'],
    ];

    for (const [method, path] of routes) {
      for (const [who, token] of [
        ['a customer', customer.accessToken],
        ['a partner', partner.accessToken],
        ['anonymous', ''],
      ] as const) {
        const res = await request.fetch(path, {
          method,
          headers: token ? auth(token) : {},
        });
        expect(
          [401, 403],
          `${method} ${path} was reachable by ${who} (${res.status()})`,
        ).toContain(res.status());
      }
    }

    const [{ commissions }] = await sql<{ commissions: string }>(
      `SELECT COUNT(*)::int AS commissions FROM "partner_commissions"`,
    );
    const [{ payouts }] = await sql<{ payouts: string }>(
      `SELECT COUNT(*)::int AS payouts FROM "partner_payouts"`,
    );
    expect(Number(commissions), 'an unauthorised call ran accrual').toBe(0);
    expect(Number(payouts), 'an unauthorised call ran the payout cycle').toBe(
      0,
    );
  });

  test('an id that is not a uuid never reaches the database', async ({
    request,
  }) => {
    // Every one of these params goes into a uuid column. Without the pipe the
    // string reaches Postgres and comes back as a cast error, which the filter
    // can only report as a 500 — an anonymous-shaped fault for what is really
    // a bad request.
    const routes: [string, string, Record<string, unknown> | undefined][] = [
      ['GET', '/admin/affiliate/partners/not-a-uuid', undefined],
      [
        'PATCH',
        '/admin/affiliate/partners/not-a-uuid/status',
        { status: 'suspended' },
      ],
      ['PATCH', '/admin/affiliate/partners/12345/commission', {}],
      ['PATCH', '/admin/affiliate/payouts/not-a-uuid', { status: 'paid' }],
      [
        'PATCH',
        '/admin/affiliate/commissions/not-a-uuid/reverse',
        { reason: 'chargeback' },
      ],
      [
        'PATCH',
        '/admin/affiliate/referrals/not-a-uuid/block',
        { reason: 'chargeback' },
      ],
    ];

    for (const [method, path, data] of routes) {
      const res = await request.fetch(path, {
        method,
        headers: auth(admin.accessToken),
        ...(data ? { data } : {}),
      });
      expect(res.status(), `${method} ${path}: ${await res.text()}`).toBe(400);
      expect((await errorOf(res)).code).toBe('INVALID_INPUT');
    }
  });

  test('a well-formed id that belongs to nobody is a 404, not a silent no-op', async ({
    request,
  }) => {
    // setStatus and setCommissionOverride both UPDATE first and read back
    // second, so a missing row is zero rows affected rather than an error. If
    // the read-back check were ever dropped, an admin would get a 200 for a
    // change that never happened.
    const routes: [string, string, Record<string, unknown> | undefined][] = [
      ['GET', `/admin/affiliate/partners/${ABSENT_UUID}`, undefined],
      [
        'PATCH',
        `/admin/affiliate/partners/${ABSENT_UUID}/status`,
        { status: 'suspended' },
      ],
      [
        'PATCH',
        `/admin/affiliate/partners/${ABSENT_UUID}/commission`,
        { commissionType: 'percent', commissionRate: 5 },
      ],
      ['PATCH', `/admin/affiliate/payouts/${ABSENT_UUID}`, { status: 'paid' }],
      [
        'PATCH',
        `/admin/affiliate/commissions/${ABSENT_UUID}/reverse`,
        { reason: 'chargeback' },
      ],
    ];

    for (const [method, path, data] of routes) {
      const res = await request.fetch(path, {
        method,
        headers: auth(admin.accessToken),
        ...(data ? { data } : {}),
      });
      expect(res.status(), `${method} ${path}: ${await res.text()}`).toBe(404);
      expect((await errorOf(res)).code).toBe('NOT_FOUND');
    }
  });

  test('a partner status outside the enum leaves the stored status alone', async ({
    request,
  }) => {
    // Every one of these reaches @IsEnum as-is. The pipe runs with
    // enableImplicitConversion and the property's reflected type is String, so
    // 42 is stringified to "42" and still fails; an array takes
    // class-transformer's array branch, which maps its members and hands back
    // an array, and isEnum() is an `includes` against the member list, which an
    // array can never satisfy. A single-element array is the shape that could
    // conceivably have been coerced to its member, so it is listed explicitly.
    const rejected: unknown[] = [
      'deleted', // not a member
      'ACTIVE', // right word, wrong case
      '', // empty string is not null-shaped, it is just invalid
      ' active', // leading whitespace is not trimmed away for you
      ['active', 'suspended'], // array where a scalar is expected
      ['suspended'], // ...and the one-element case, which stays an array too
      42,
    ];

    for (const status of rejected) {
      const res = await request.patch(
        `/admin/affiliate/partners/${partner.id}/status`,
        { data: { status }, headers: auth(admin.accessToken) },
      );
      expect(
        res.status(),
        `status ${JSON.stringify(status)} was accepted`,
      ).toBe(400);
    }

    // Missing entirely is a different failure from wrong, and equally a 400 —
    // the field has no @IsOptional.
    const missing = await request.patch(
      `/admin/affiliate/partners/${partner.id}/status`,
      {
        data: { adminNotes: 'no status supplied' },
        headers: auth(admin.accessToken),
      },
    );
    expect(missing.status()).toBe(400);

    // The status code is only half of it: a suspension must never arrive by
    // type confusion, so the stored row is checked as well. adminNotes proves
    // the rejected body was not partially applied either.
    const [row] = await sql<{ status: string; adminNotes: string | null }>(
      `SELECT "status", "adminNotes" FROM "partners" WHERE "id" = $1`,
      [partner.id],
    );
    expect(row.status).toBe('active');
    expect(row.adminNotes).toBeNull();
  });

  test('a commission override has to be set and cleared as a pair', async ({
    request,
  }) => {
    // Half an override is not a rate: a type with no number, or a number with
    // no type, would make the accrual fall back in a way nobody asked for.
    const half = [{ commissionRate: 20 }, { commissionType: 'percent' }];

    for (const data of half) {
      const res = await request.patch(
        `/admin/affiliate/partners/${partner.id}/commission`,
        { data, headers: auth(admin.accessToken) },
      );
      expect(res.status(), `accepted ${JSON.stringify(data)}`).toBe(400);
      expect((await errorOf(res)).message).toContain('together');
    }

    const both = await request.patch(
      `/admin/affiliate/partners/${partner.id}/commission`,
      {
        data: { commissionType: 'flat', commissionRate: 12.5 },
        headers: auth(admin.accessToken),
      },
    );
    expect(both.status(), await both.text()).toBe(200);

    const [set] = await sql<{ commissionType: string; commissionRate: string }>(
      `SELECT "commissionType", "commissionRate" FROM "partners" WHERE "id" = $1`,
      [partner.id],
    );
    expect(set.commissionType).toBe('flat');
    expect(Number(set.commissionRate)).toBe(12.5);

    const cleared = await request.patch(
      `/admin/affiliate/partners/${partner.id}/commission`,
      {
        data: { commissionType: null, commissionRate: null },
        headers: auth(admin.accessToken),
      },
    );
    expect(cleared.status(), await cleared.text()).toBe(200);

    const [after] = await sql<{
      commissionType: string | null;
      commissionRate: string | null;
    }>(
      `SELECT "commissionType", "commissionRate" FROM "partners" WHERE "id" = $1`,
      [partner.id],
    );
    // Null means "follow the global rate", which is not the same as a copy of
    // today's global rate — a later change has to reach this partner.
    expect(after.commissionType).toBeNull();
    expect(after.commissionRate).toBeNull();
  });

  test('an empty commission patch silently clears an existing override', async ({
    request,
  }) => {
    // The handler reads `dto.commissionType ?? null`, so an omitted field is
    // indistinguishable from an explicit null and a PATCH carrying nothing at
    // all reverts the partner to the global rate. That is a destructive default
    // for a route whose other verbs are all additive. Pinned as it behaves
    // today; making omission mean "leave alone" is a src change.
    await request.patch(`/admin/affiliate/partners/${partner.id}/commission`, {
      data: { commissionType: 'flat', commissionRate: 42 },
      headers: auth(admin.accessToken),
    });

    const empty = await request.patch(
      `/admin/affiliate/partners/${partner.id}/commission`,
      { data: {}, headers: auth(admin.accessToken) },
    );
    expect(empty.status(), await empty.text()).toBe(200);

    const [row] = await sql<{ commissionRate: string | null }>(
      `SELECT "commissionRate" FROM "partners" WHERE "id" = $1`,
      [partner.id],
    );
    expect(
      row.commissionRate,
      'if this is now 42, an empty patch stopped clearing the override — delete this test',
    ).toBeNull();
  });

  test('a commission rate outside its bounds is refused, and a numeric string is not', async ({
    request,
  }) => {
    // 100 is the cap for both meanings of the field: as a percentage anything
    // above pays out more than the OTP earned, and ₹100 per OTP is already
    // implausible. Four decimal places is what the column stores.
    // `null` is deliberately absent: @IsOptional() waves it through, and it
    // then means "clear the override", which the pair test above covers.
    const rejected = [101, -1, 100.5, 20.00005, 'abc', '1e309'];

    for (const commissionRate of rejected) {
      const res = await request.patch(
        `/admin/affiliate/partners/${partner.id}/commission`,
        {
          data: { commissionType: 'percent', commissionRate },
          headers: auth(admin.accessToken),
        },
      );
      expect(
        res.status(),
        `commissionRate ${JSON.stringify(commissionRate)} was accepted`,
      ).toBe(400);
    }

    // Query-string-shaped numbers arrive as strings from real clients, and the
    // DTO converts rather than rejecting them.
    const coerced = await request.patch(
      `/admin/affiliate/partners/${partner.id}/commission`,
      {
        data: { commissionType: 'percent', commissionRate: '20' },
        headers: auth(admin.accessToken),
      },
    );
    expect(coerced.status(), await coerced.text()).toBe(200);

    const [row] = await sql<{ commissionRate: string }>(
      `SELECT "commissionRate" FROM "partners" WHERE "id" = $1`,
      [partner.id],
    );
    expect(Number(row.commissionRate)).toBe(20);

    // The boundary values themselves are legal.
    for (const commissionRate of [0, 100]) {
      const res = await request.patch(
        `/admin/affiliate/partners/${partner.id}/commission`,
        {
          data: { commissionType: 'percent', commissionRate },
          headers: auth(admin.accessToken),
        },
      );
      expect(
        res.status(),
        `commissionRate ${commissionRate}: ${await res.text()}`,
      ).toBe(200);
    }
  });

  test('settings fields the caller does not own are ignored, not written', async ({
    request,
  }) => {
    // lastAccrualAt is the accrual watermark. A client that could wind it back
    // would make the next run re-scan a window it has already paid for; the
    // message-id unique constraint would catch the duplicates, but the
    // watermark itself would be wrong from then on. isSingleton is what makes
    // the row a singleton at all.
    const res = await request.patch('/admin/affiliate/settings', {
      data: {
        minPayoutAmount: 250,
        isSingleton: false,
        lastAccrualAt: '2020-01-01T00:00:00.000Z',
        somethingNobodyDeclared: 'x',
      },
      headers: auth(admin.accessToken),
    });
    // Unknown properties are stripped rather than refused — whitelist is on,
    // forbidNonWhitelisted is not. Asserted so the policy is a decision on
    // record rather than an accident.
    expect(res.status(), await res.text()).toBe(200);

    const settings = await readSettings();
    expect(Number(settings.minPayoutAmount)).toBe(250);
    expect(settings.isSingleton).toBe(true);
    expect(settings.lastAccrualAt).toBeNull();
  });

  test('a payout status outside the enum, or an over-long reference, leaves the payout alone', async ({
    request,
  }) => {
    const id = await raisePayout(request);

    const rejected: Record<string, unknown>[] = [
      { status: 'refunded' },
      { status: 'PAID' },
      { status: 'accrued' }, // a commission status, not a payout one
      {}, // status is required
      { status: 'paid', paymentReference: 'U'.repeat(201) },
      { status: 'failed', failureReason: 'x'.repeat(2001) },
    ];

    for (const data of rejected) {
      const res = await request.patch(`/admin/affiliate/payouts/${id}`, {
        data,
        headers: auth(admin.accessToken),
      });
      expect(
        res.status(),
        `accepted ${JSON.stringify(data).slice(0, 60)}`,
      ).toBe(400);
    }

    // Validation runs before the transaction, so nothing was locked, written or
    // released by any of the above.
    const [row] = await sql<{ status: string; paidAt: Date | null }>(
      `SELECT "status", "paidAt" FROM "partner_payouts" WHERE "id" = $1`,
      [id],
    );
    expect(row.status).toBe('pending');
    expect(row.paidAt).toBeNull();

    const totals = await partnerTotals(partner.id);
    expect(totals.ledger.paid).toBe(100);
    expect(totals.cached).toEqual(totals.ledger);
  });

  test('two admins failing the same payout at once release the money exactly once', async ({
    request,
  }) => {
    // The row is locked FOR UPDATE for the length of the transaction precisely
    // so this cannot double-release. Sequential re-sends are covered in
    // tests/e2e/affiliate/payout-lifecycle.spec.ts; this is the concurrent case
    // the lock exists for, and a double release would credit the partner ₹200
    // for ₹100 of work.
    const id = await raisePayout(request);

    const both = await Promise.all([
      request.patch(`/admin/affiliate/payouts/${id}`, {
        data: { status: 'failed', failureReason: 'Bank rejected' },
        headers: auth(admin.accessToken),
      }),
      request.patch(`/admin/affiliate/payouts/${id}`, {
        data: { status: 'failed', failureReason: 'Bank rejected' },
        headers: auth(admin.accessToken),
      }),
    ]);

    for (const res of both) {
      expect(res.status(), await res.text()).toBe(200);
    }

    const totals = await partnerTotals(partner.id);
    expect(totals.ledger.unpaid).toBe(100);
    expect(totals.ledger.paid).toBe(0);
    expect(totals.ledger.lifetime).toBe(100);
    expect(totals.cached).toEqual(totals.ledger);
  });

  test('a payout cannot be settled and failed at the same time', async ({
    request,
  }) => {
    // Whichever lands first wins and the other must be refused: a payout that
    // reads PAID while its commissions sit accrued would be paid a second time
    // by the next cycle.
    const id = await raisePayout(request);

    const [paid, failed] = await Promise.all([
      request.patch(`/admin/affiliate/payouts/${id}`, {
        data: { status: 'paid', paymentReference: 'UTR-1' },
        headers: auth(admin.accessToken),
      }),
      request.patch(`/admin/affiliate/payouts/${id}`, {
        data: { status: 'failed', failureReason: 'Bank rejected' },
        headers: auth(admin.accessToken),
      }),
    ]);

    expect(
      [paid.status(), failed.status()].sort(),
      `paid=${paid.status()} failed=${failed.status()}`,
    ).toEqual([200, 400]);

    const [row] = await sql<{ status: string }>(
      `SELECT "status" FROM "partner_payouts" WHERE "id" = $1`,
      [id],
    );
    const totals = await partnerTotals(partner.id);

    // Whichever won, the ledger has to agree with it — and the cache with the
    // ledger.
    if (row.status === 'paid') {
      expect(totals.ledger.paid).toBe(100);
      expect(totals.ledger.unpaid).toBe(0);
    } else {
      expect(row.status).toBe('failed');
      expect(totals.ledger.paid).toBe(0);
      expect(totals.ledger.unpaid).toBe(100);
    }
    expect(totals.cached).toEqual(totals.ledger);
  });

  test('blocking a referral twice does not claw the money back twice', async ({
    request,
  }) => {
    // Two people working the same fraud report, or one double-click. The
    // reversal predicate only touches rows still `accrued`, which is what makes
    // the second call a no-op instead of a second ₹100 off the balance.
    const { referralId } = await earning(request);

    const first = await request.patch(
      `/admin/affiliate/referrals/${referralId}/block`,
      { data: { reason: 'Self-referral' }, headers: auth(admin.accessToken) },
    );
    expect(first.status(), await first.text()).toBe(200);
    expect(
      await payload<{ reversed: number; alreadyPaid: number }>(first),
    ).toMatchObject({ reversed: 1, alreadyPaid: 0 });

    const afterFirst = await partnerTotals(partner.id);

    const second = await request.patch(
      `/admin/affiliate/referrals/${referralId}/block`,
      { data: { reason: 'Self-referral' }, headers: auth(admin.accessToken) },
    );
    expect(second.status(), await second.text()).toBe(200);
    expect(
      await payload<{ reversed: number; alreadyPaid: number }>(second),
    ).toMatchObject({ reversed: 0, alreadyPaid: 0 });

    const afterSecond = await partnerTotals(partner.id);
    expect(afterSecond).toEqual(afterFirst);
    expect(afterSecond.ledger.unpaid).toBe(0);
    // A balance can never be driven negative by a repeated remediation.
    expect(afterSecond.cached.unpaid).toBe(0);
    expect(afterSecond.cached.lifetime).toBe(0);
  });

  test('a reason made only of spaces is accepted as the audit record', async ({
    request,
  }) => {
    // @MinLength(3) counts characters, and three spaces are three characters.
    // The reason is the only record of why money was taken off a partner, and
    // it is what they are shown when they dispute it — so this is a hole in the
    // one field the DTO made mandatory for exactly that purpose. Asserted as it
    // behaves today; a trim belongs in the DTO, not in this file.
    const { commissionId } = await earning(request);

    const res = await request.patch(
      `/admin/affiliate/commissions/${commissionId}/reverse`,
      { data: { reason: '   ' }, headers: auth(admin.accessToken) },
    );
    expect(
      res.status(),
      'if this is now 400, the reason field learned to trim — delete this test',
    ).toBe(200);

    const [row] = await sql<{ status: string; reversedReason: string }>(
      `SELECT "status", "reversedReason" FROM "partner_commissions" WHERE "id" = $1`,
      [commissionId],
    );
    expect(row.status).toBe('reversed');
    expect(row.reversedReason?.trim()).toBe('');
  });

  test('the programme overview reports exact numbers, not numeric strings', async ({
    request,
  }) => {
    // Every figure is a Postgres numeric or bigint, which comes back from pg as
    // a string. One that escaped the Number() cast would concatenate the moment
    // the dashboard added anything to it.
    //
    // activePartners and pendingApplications are counts over the whole table,
    // so the exact figures below are the beforeEach fixture: resetDb truncates
    // `partners` and exactly one partner is created. Change that fixture and
    // these two numbers change with it.
    await earning(request);

    const before = await request.get('/admin/affiliate/overview', {
      headers: auth(admin.accessToken),
    });
    expect(before.status(), await before.text()).toBe(200);

    const accrued = await payload<Record<string, unknown>>(before);
    for (const [key, value] of Object.entries(accrued)) {
      expect(typeof value, `overview.${key} came back as ${typeof value}`).toBe(
        'number',
      );
    }
    expect(accrued).toMatchObject({
      totalAccrued: 100,
      totalPaid: 0,
      pendingPayoutAmount: 0,
      pendingPayoutCount: 0,
      pendingApplications: 0,
      activePartners: 1,
    });

    await runPayouts(request, admin.accessToken);

    const after = await request.get('/admin/affiliate/overview', {
      headers: auth(admin.accessToken),
    });
    expect(await payload<Record<string, unknown>>(after)).toMatchObject({
      totalAccrued: 0,
      totalPaid: 100,
      // The payout is raised but not yet settled, so the money is both "paid"
      // in the ledger and outstanding in the queue.
      pendingPayoutAmount: 100,
      pendingPayoutCount: 1,
    });
  });

  test('the admin partner list refuses any sort key outside its allowlist', async ({
    request,
  }) => {
    // sortBy is interpolated into ORDER BY once resolved, so the allowlist is
    // the whole defence. `constructor` and `__proto__` are here because a
    // prototype-chain lookup would resolve both to an inherited function and
    // put garbage in the query — the DTO's @IsIn stops them before the resolver
    // is even reached.
    for (const sortBy of [
      'passwordHash',
      'constructor',
      '__proto__',
      'toString',
      'created_at; DROP TABLE partners',
      'partner.email',
    ]) {
      const res = await request.get(
        `/admin/affiliate/partners?sortBy=${encodeURIComponent(sortBy)}`,
        { headers: auth(admin.accessToken) },
      );
      expect(res.status(), `sortBy=${sortBy} was accepted`).toBe(400);
    }

    for (const sortBy of ['created_at', 'email', 'unpaid', 'last_login']) {
      const res = await request.get(
        `/admin/affiliate/partners?sortBy=${sortBy}&sortOrder=ASC`,
        { headers: auth(admin.accessToken) },
      );
      expect(res.status(), `sortBy=${sortBy}: ${await res.text()}`).toBe(200);
    }
  });

  test('partner search, the status filter and a legal sort actually shape the result', async ({
    request,
  }) => {
    // The negatives above prove illegal inputs are refused; nothing proved the
    // legal ones DO anything — search was entirely untested and status/sortBy
    // were only ever asserted to answer 200.
    const zebra = await createPartner(request, {
      email: `zebra-search-${Date.now()}@example.com`,
    });
    await sql(
      `UPDATE "partners"
          SET "firstName" = 'Zeenat', "companyName" = 'Zebra Growth Co',
              "status" = 'suspended', "refreshTokenHash" = NULL
        WHERE "id" = $1`,
      [zebra.id],
    );

    const idsOf = async (qs: string) => {
      const res = await request.get(`/admin/affiliate/partners?${qs}`, {
        headers: auth(admin.accessToken),
      });
      expect(res.status(), `${qs}: ${await res.text()}`).toBe(200);
      return (await payload<{ id: string }[]>(res)).map((p) => p.id);
    };

    // Search matches across email, name and company — and only the partner
    // that carries the term.
    expect(await idsOf('search=zebra-search')).toEqual([zebra.id]);
    expect(await idsOf('search=Zeenat')).toEqual([zebra.id]);
    expect(await idsOf(`search=${encodeURIComponent('Zebra Growth')}`)).toEqual([
      zebra.id,
    ]);
    expect(await idsOf('search=no-partner-carries-this')).toEqual([]);

    // The status filter keeps exactly the matching cohort.
    expect(await idsOf('status=suspended')).toEqual([zebra.id]);
    expect(await idsOf('status=active')).toEqual([partner.id]);

    // And a legal sort really orders: by email, both directions, over both
    // partners.
    const emailsOf = async (qs: string) => {
      const res = await request.get(`/admin/affiliate/partners?${qs}`, {
        headers: auth(admin.accessToken),
      });
      return (await payload<{ email: string }[]>(res)).map((p) => p.email);
    };
    const asc = await emailsOf('sortBy=email&sortOrder=asc');
    expect(asc).toEqual([...asc].sort());
    expect(asc).toHaveLength(2);
    const desc = await emailsOf('sortBy=email&sortOrder=desc');
    expect(desc).toEqual([...asc].reverse());
  });

  test('the partner detail serves the funnel the route exists for', async ({
    request,
  }) => {
    // 400/404 and the suspended-eligibility reason were pinned; the stats —
    // clicks, signups, qualified, conversion — never were, so an all-zero
    // funnel forever would have passed. Two click-days, two signups of which
    // one qualified, all seeded into the same tables the scalar subqueries
    // read.
    await sql(
      `INSERT INTO "referral_clicks" ("partnerId", "date", "clicks", "uniqueClicks")
       VALUES ($1, (now() AT TIME ZONE 'Asia/Kolkata')::date, 3, 2),
              ($1, (now() AT TIME ZONE 'Asia/Kolkata')::date - 1, 1, 1)`,
      [partner.id],
    );
    const pendingUser = await seedCustomer();
    await seedReferral(partner.id, pendingUser.id, partner.referralCode);
    const qualifiedUser = await seedCustomer();
    await seedReferral(
      partner.id,
      qualifiedUser.id,
      partner.referralCode,
      'qualified',
    );
    await seedDeliveredMessage(qualifiedUser.id, { costAmount: 1 });
    await runAccrual(request, admin.accessToken);

    const res = await request.get(`/admin/affiliate/partners/${partner.id}`, {
      headers: auth(admin.accessToken),
    });
    expect(res.status(), await res.text()).toBe(200);

    const body = await payload<{
      partner: { id: string; email: string };
      referralLink: string;
      stats: {
        clicks: number;
        uniqueClicks: number;
        signups: number;
        qualifiedReferrals: number;
        unpaidEarnings: number;
        lifetimeEarnings: number;
        paidEarnings: number;
        signupConversionRate: number;
      };
      payout: { isEligible: boolean; reason?: string };
    }>(res);

    expect(body.partner.id).toBe(partner.id);
    expect(body.referralLink).toContain(partner.referralCode);

    expect(body.stats.clicks).toBe(4);
    expect(body.stats.uniqueClicks).toBe(3);
    expect(body.stats.signups).toBe(2);
    expect(body.stats.qualifiedReferrals).toBe(1);
    // One delivered ₹1 message at the flat ₹100 rate the beforeEach set.
    expect(body.stats.unpaidEarnings).toBe(100);
    expect(body.stats.lifetimeEarnings).toBe(100);
    expect(body.stats.paidEarnings).toBe(0);
    // 2 signups over 4 clicks.
    expect(body.stats.signupConversionRate).toBe(50);

    // The positive eligibility view: one qualified referral and ₹100 unpaid
    // clear the thresholds the beforeEach configured (1 and ₹10), and the
    // beforeEach put a UPI destination on file.
    expect(body.payout.isEligible).toBe(true);
    expect(body.payout.reason).toBeUndefined();
  });

  test('the admin partner list never carries password material', async ({
    request,
  }) => {
    // Both columns are select:false on the entity and deleted again by
    // sanitize(); this is the assertion that keeps a future addSelect from
    // leaking them into a list nobody re-reviews.
    const res = await request.get('/admin/affiliate/partners?limit=100', {
      headers: auth(admin.accessToken),
    });
    expect(res.status(), await res.text()).toBe(200);

    const rows = await payload<Record<string, unknown>[]>(res);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row).not.toHaveProperty('passwordHash');
      expect(row).not.toHaveProperty('refreshTokenHash');
    }
    expect(JSON.stringify(rows)).not.toContain('$2b$');
  });
});
