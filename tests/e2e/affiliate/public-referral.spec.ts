import { test, expect } from '@playwright/test';
import { resetDb, closeDb, sql } from '../helpers/db.js';
import {
  createAdmin,
  createCustomer,
  createPartner,
  updateSettings,
  payload,
  unique,
  Customer,
  Partner,
} from '../helpers/actors.js';
import {
  errorOf,
  setsReferralCookie,
  referralCookieValue,
  referralFor,
  track,
} from './edge-helpers.js';

/**
 * The seams of the unauthenticated click endpoint — the only affiliate surface
 * an anonymous caller can reach at all — after the rest of affiliate/ and
 * platform/partner-session have covered the flows themselves.
 *
 * Nothing here re-asserts a happy path. What is left once accrual, payouts,
 * remediation and attribution are pinned down is the edge.
 */

test.describe('the public referral endpoint', () => {
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

  test('the answer is the same whether or not the programme is running', async ({
    request,
  }) => {
    // Settings are cached for 30s in-process, so the toggle goes through the
    // admin API rather than straight to the row — otherwise this would assert
    // against whatever the previous test left in the cache.
    await updateSettings(request, admin.accessToken, { isEnabled: false });

    const off = await track(request, { code: partner.referralCode });
    const unknown = await track(request, { code: 'NOSUCHCODE' });

    expect(off.status()).toBe(unknown.status());
    expect(await payload(off)).toEqual(await payload(unknown));
    expect(
      setsReferralCookie(off),
      'a cookie was dropped while the programme was off',
    ).toBe(false);

    await updateSettings(request, admin.accessToken, { isEnabled: true });

    const on = await track(request, { code: partner.referralCode });
    expect(on.status()).toBe(off.status());
    // Identical body, different side effect: the caller learns nothing about
    // the programme's state, which is the point of the uniform response.
    expect(await payload(on)).toEqual(await payload(off));
    expect(setsReferralCookie(on)).toBe(true);
  });

  test("a suspended partner's link sets no cookie and records no click", async ({
    request,
  }) => {
    await updateSettings(request, admin.accessToken, { isEnabled: true });
    await sql(`UPDATE "partners" SET "status" = 'suspended' WHERE "id" = $1`, [
      partner.id,
    ]);

    const res = await track(request, { code: partner.referralCode });
    expect(res.ok(), await res.text()).toBeTruthy();
    expect(
      setsReferralCookie(res),
      'a suspended partner was still being attributed traffic',
    ).toBe(false);

    // The click counter only runs once a partner has been resolved, so a
    // suspended one leaves nothing behind to inflate their funnel with.
    const [{ count }] = await sql<{ count: string }>(
      `SELECT COUNT(*)::int AS count FROM "referral_clicks" WHERE "partnerId" = $1`,
      [partner.id],
    );
    expect(Number(count)).toBe(0);
  });

  test('the cookie carries the normalised code, so a padded lowercase link still attributes', async ({
    request,
  }) => {
    // Codes are read aloud, typed from screenshots and pasted with whitespace.
    // The cookie is what attribution later matches on, so the normalisation has
    // to happen before it is written, not at read time.
    await updateSettings(request, admin.accessToken, { isEnabled: true });

    const res = await track(request, {
      code: `  ${partner.referralCode.toLowerCase()}  `,
      landingPath: '/pricing',
    });
    expect(res.ok(), await res.text()).toBeTruthy();

    const cookie = referralCookieValue(res);
    expect(cookie).toBe(partner.referralCode);

    const customer = await createCustomer(request, {
      referralCookie: cookie as string,
    });
    expect((await referralFor(customer.id))?.partnerId).toBe(partner.id);
  });

  test('a code the normaliser rejects is answered ok and attributes nobody', async ({
    request,
  }) => {
    // The DTO caps the length but sets no minimum and no charset; the service
    // regex is what actually decides. Anything it turns down has to leave the
    // response indistinguishable from a valid-but-unknown code, or the endpoint
    // becomes an oracle for which codes exist.
    await updateSettings(request, admin.accessToken, { isEnabled: true });

    const baseline = await track(request, { code: 'ZZZZZZZZ' });
    const expected = await payload(baseline);

    for (const code of [
      'AB', // shorter than four
      'AB-CD', // punctuation is not in the alphabet
      '🎉🎉🎉🎉', // four characters, none of them A-Z0-9
      'X'.repeat(32), // exactly at the length cap, still unknown
      12345678, // a number, coerced to a string by the pipe
    ]) {
      const res = await track(request, { code });
      expect(
        res.status(),
        `code ${JSON.stringify(code)} was not answered like an unknown one`,
      ).toBe(baseline.status());
      expect(await payload(res)).toEqual(expected);
      expect(setsReferralCookie(res), `code ${String(code)} set a cookie`).toBe(
        false,
      );
    }

    const [{ count }] = await sql<{ count: string }>(
      `SELECT COUNT(*)::int AS count FROM "referral_clicks"`,
    );
    expect(Number(count), 'a junk code was counted as a click').toBe(0);
  });

  test('the tracked code and landing path are length-capped', async ({
    request,
  }) => {
    await updateSettings(request, admin.accessToken, { isEnabled: true });

    const overLong = await track(request, { code: 'X'.repeat(33) });
    expect(overLong.status()).toBe(400);
    expect((await errorOf(overLong)).code).toBe('VALIDATION_ERROR');

    const nullCode = await track(request, { code: null });
    expect(nullCode.status()).toBe(400);

    const longPath = await track(request, {
      code: partner.referralCode,
      landingPath: `/${'x'.repeat(500)}`,
    });
    expect(longPath.status()).toBe(400);

    // And the boundary itself is fine.
    const atCap = await track(request, {
      code: partner.referralCode,
      landingPath: `/${'x'.repeat(499)}`,
    });
    expect(atCap.status(), await atCap.text()).toBe(201);
  });

  test('the attribution cookie is HttpOnly, Lax, root-pathed and lives as long as the settings say', async ({
    request,
  }) => {
    // This cookie decides who earns money for the next sixty days, and none of
    // its attributes were asserted anywhere. HttpOnly is the property that
    // stops a partner forging attribution from page script; Max-Age is
    // cookieDurationDays converted to seconds; Lax is what lets the cookie
    // survive the cross-site navigation that IS a referral click.
    await updateSettings(request, admin.accessToken, { isEnabled: true });

    const res = await track(request, { code: partner.referralCode });
    expect(res.ok(), await res.text()).toBeTruthy();

    const setCookie = res.headers()['set-cookie'] ?? '';
    const line = setCookie
      .split('\n')
      .find((l) => l.includes('sm_ref=')) as string;
    expect(line, setCookie).toBeTruthy();

    expect(line).toMatch(/HttpOnly/i);
    expect(line).toMatch(/SameSite=Lax/i);
    expect(line).toMatch(/Path=\//);
    // resetDb pins cookieDurationDays at the shipped default of 60.
    expect(line).toContain(`Max-Age=${60 * 24 * 60 * 60}`);
    // Not Secure in this environment — NODE_ENV is test — so a localhost
    // dashboard can still see attribution work end to end.
    expect(line).not.toMatch(/;\s*Secure/i);

    // And the duration really is the setting, not a constant: shorten it and
    // the next click's cookie shortens with it.
    await updateSettings(request, admin.accessToken, { cookieDurationDays: 7 });
    const shorter = await track(request, { code: partner.referralCode });
    expect(shorter.headers()['set-cookie']).toContain(
      `Max-Age=${7 * 24 * 60 * 60}`,
    );
  });

  test('the thirty-first click in a minute from one address is throttled', async ({
    request,
  }) => {
    // @Throttle 30/min on the handler — the only cap on an unauthenticated
    // endpoint that writes click rows. resetDb flushes the Redis counters, so
    // the whole budget is spent inside this one test; unknown codes keep every
    // request cheap and write nothing.
    const statuses: number[] = [];
    let last = await track(request, { code: 'NOSUCHCODE' });
    statuses.push(last.status());
    for (let i = 1; i < 31; i += 1) {
      last = await track(request, { code: 'NOSUCHCODE' });
      statuses.push(last.status());
    }

    expect(
      statuses.slice(0, 30).every((s) => s === 201),
      `got ${statuses.join(',')}`,
    ).toBe(true);
    expect(statuses[30], await last.text()).toBe(429);

    // A throttled click must not have been counted either.
    const [{ count }] = await sql<{ count: string }>(
      `SELECT COUNT(*)::int AS count FROM "referral_clicks"`,
    );
    expect(Number(count)).toBe(0);
  });

  test("a gmail dot-alias of the partner's own address is still a self-referral", async ({
    request,
  }) => {
    // Google ignores dots in the local part, so these two addresses are one
    // inbox and one person. A partner who could sign up through their own link
    // this way would earn commission on their own OTP spend — the cheapest
    // fraud there is, and the reason normalizeEmail strips dots for exactly the
    // Google-hosted domains where they are meaningless.
    await updateSettings(request, admin.accessToken, { isEnabled: true });

    const tag = unique('dotalias');
    const self = await createPartner(request, {
      email: `${tag}.x@gmail.com`,
    });

    const customer = await createCustomer(request, {
      email: `${tag}x@gmail.com`,
      referralCookie: self.referralCode,
    });

    expect(
      await referralFor(customer.id),
      'a partner referred themselves by removing a dot from their gmail address',
    ).toBeNull();
  });

  test('dots outside gmail belong to a different person and still earn', async ({
    request,
  }) => {
    // The other half of the same rule, and the one that costs money if it is
    // over-applied: on a provider that treats dots as significant these are two
    // people, and denying the referral would take a real commission off a real
    // partner.
    await updateSettings(request, admin.accessToken, { isEnabled: true });

    const tag = unique('dotreal');
    const other = await createPartner(request, {
      email: `${tag}.x@example.com`,
    });

    const customer = await createCustomer(request, {
      email: `${tag}x@example.com`,
      referralCookie: other.referralCode,
    });

    const referral = await referralFor(customer.id);
    expect(
      referral,
      'a genuine customer was refused because their address differed only by a dot',
    ).not.toBeNull();
    expect(referral.partnerId).toBe(other.id);
  });

  test('two people signing up as the same partner cannot both get an account', async ({
    request,
  }) => {
    // register() checks for an existing email and then inserts, which is a
    // read-then-write with no lock. The unique index on partners.email is the
    // real guarantee; this asserts it holds, because two partner rows for one
    // address would mean two referral codes and a split of the same person's
    // earnings.
    const email = `${unique('race')}@example.com`;
    const body = {
      email,
      password: 'Password123!',
      firstName: 'A',
      lastName: 'B',
    };

    const both = await Promise.all([
      request.post('/partner/auth/register', { data: body }),
      request.post('/partner/auth/register', { data: body }),
    ]);

    const [{ count }] = await sql<{ count: string }>(
      `SELECT COUNT(*)::int AS count FROM "partners" WHERE "email" = $1`,
      [email],
    );
    expect(Number(count), 'the same email registered twice').toBe(1);

    const accepted = both.filter((res) => res.ok()).length;
    expect(
      accepted,
      'both concurrent registrations were told they succeeded',
    ).toBe(1);
  });
});
