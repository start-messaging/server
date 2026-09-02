import { test, expect, APIRequestContext } from '@playwright/test';
import { resetDb, closeDb, sql } from '../helpers/db.js';
import {
  createAdmin,
  createPartner,
  createCustomer,
  updateSettings,
  unique,
  auth,
  payload,
  Customer,
  Partner,
} from '../helpers/actors.js';

/**
 * Referral attribution: click -> cookie -> signup -> referral row.
 *
 * Attribution decides who earns for a customer's entire lifetime, and it is
 * driven by an unauthenticated endpoint and a cookie the client controls, so
 * the interesting cases are all adversarial.
 */
test.describe('referral attribution', () => {
  let admin: Customer;
  let partner: Partner;

  test.beforeEach(async ({ request }) => {
    await resetDb();
    admin = await createAdmin(request);
    partner = await createPartner(request);
    await updateSettings(request, admin.accessToken, { isEnabled: true });
  });

  test.afterAll(async () => {
    await closeDb();
  });

  /** Posts a click and returns the sm_ref cookie value the server set, if any. */
  async function track(
    request: APIRequestContext,
    code: string,
  ): Promise<string | null> {
    const res = await request.post('/affiliate/track', {
      data: { code, landingPath: '/pricing' },
    });
    expect(res.ok(), await res.text()).toBeTruthy();

    const raw = res.headers()['set-cookie'] ?? '';
    const match = /sm_ref=([^;]+)/.exec(raw);
    return match ? match[1] : null;
  }

  async function referralFor(userId: string) {
    const [row] = await sql<{
      partnerId: string;
      status: string;
      referralCode: string;
    }>(
      `SELECT "partnerId", "status", "referralCode" FROM "referrals" WHERE "userId" = $1`,
      [userId],
    );
    return row ?? null;
  }

  test('a click sets the referral cookie and signup attributes the user', async ({
    request,
  }) => {
    const cookie = await track(request, partner.referralCode);
    expect(cookie).toBeTruthy();

    const customer = await createCustomer(request, {
      referralCookie: cookie as string,
    });

    const referral = await referralFor(customer.id);
    expect(referral).not.toBeNull();
    expect(referral.partnerId).toBe(partner.id);
    expect(referral.status).toBe('pending');
  });

  test('signup without a cookie creates no referral', async ({ request }) => {
    const customer = await createCustomer(request);
    expect(await referralFor(customer.id)).toBeNull();
  });

  test('an unknown code answers identically and attributes nobody', async ({
    request,
  }) => {
    const good = await request.post('/affiliate/track', {
      data: { code: partner.referralCode },
    });
    const bad = await request.post('/affiliate/track', {
      data: { code: 'NOSUCHCODE' },
    });

    // Uniform response: an unauthenticated endpoint that distinguished the two
    // would let anyone enumerate valid partner codes.
    // Compared on the payload: requestId and timestamp differ by design and
    // leak nothing.
    expect(bad.status()).toBe(good.status());
    expect(await payload(bad)).toEqual(await payload(good));

    const customer = await createCustomer(request, { referralCookie: 'NOSUCHCODE' });
    expect(await referralFor(customer.id)).toBeNull();
  });

  test('the referral code is matched case-insensitively', async ({
    request,
  }) => {
    const customer = await createCustomer(request, {
      referralCookie: partner.referralCode.toLowerCase(),
    });

    const referral = await referralFor(customer.id);
    expect(referral?.partnerId).toBe(partner.id);
  });

  test('a partner cannot refer themselves with their own email', async ({
    request,
  }) => {
    const customer = await createCustomer(request, {
      email: partner.email,
      referralCookie: partner.referralCode,
    });

    expect(await referralFor(customer.id)).toBeNull();
  });

  test('a plus-alias of the partner email is still a self-referral', async ({
    request,
  }) => {
    const [local, domain] = partner.email.split('@');
    const customer = await createCustomer(request, {
      email: `${local}+newcustomer@${domain}`,
      referralCookie: partner.referralCode,
    });

    expect(
      await referralFor(customer.id),
      'a +alias delivers to the same inbox and must not earn commission',
    ).toBeNull();
  });

  test('attribution is frozen: a later click cannot steal an existing customer', async ({
    request,
  }) => {
    const first = await createCustomer(request, {
      referralCookie: partner.referralCode,
    });
    expect((await referralFor(first.id))?.partnerId).toBe(partner.id);

    const thief = await createPartner(request);

    // Re-registering is impossible, so simulate the other route: the same user
    // id reaching attribution again under a different code.
    await sql(
      `INSERT INTO "referrals" ("partnerId", "userId", "referralCode", "status")
       VALUES ($1, $2, $3, 'pending')
       ON CONFLICT ("userId") DO NOTHING`,
      [thief.id, first.id, thief.referralCode],
    );

    expect((await referralFor(first.id))?.partnerId).toBe(partner.id);
  });

  test('one customer can never be attributed to two partners', async ({
    request,
  }) => {
    const customer = await createCustomer(request, {
      referralCookie: partner.referralCode,
    });
    const other = await createPartner(request);

    await expect(
      sql(
        `INSERT INTO "referrals" ("partnerId", "userId", "referralCode", "status")
         VALUES ($1, $2, $3, 'pending')`,
        [other.id, customer.id, other.referralCode],
      ),
    ).rejects.toThrow(/UQ_referrals_userId|duplicate key/);
  });

  test('a brand-new partner attributes immediately', async ({ request }) => {
    // Signing up no longer waits for approval — the link works at once. The
    // money is held at the payout end instead.
    const fresh = await createPartner(request);

    const customer = await createCustomer(request, {
      referralCookie: fresh.referralCode,
    });
    expect((await referralFor(customer.id))?.partnerId).toBe(fresh.id);
  });

  test('a suspended partner earns no attribution', async ({ request }) => {
    const suspended = await createPartner(request, { status: 'suspended' });

    const customer = await createCustomer(request, {
      referralCookie: suspended.referralCode,
    });
    expect(await referralFor(customer.id)).toBeNull();
  });

  test('attribution is skipped entirely while the programme is disabled', async ({
    request,
  }) => {
    await updateSettings(request, admin.accessToken, { isEnabled: false });

    const customer = await createCustomer(request, {
      referralCookie: partner.referralCode,
    });
    expect(await referralFor(customer.id)).toBeNull();
  });

  test('a malformed cookie does not break signup', async ({ request }) => {
    // cookie-parser JSON-decodes any value prefixed with `j:`, so this arrives
    // as a number rather than a string. Calling .trim() on it used to throw a
    // TypeError outside the attribution try/catch and turn a live signup into
    // a 500.
    for (const value of ['j%3A1', 'j%3A%7B%22a%22%3A1%7D', '', '!!!!']) {
      const email = `${unique('malformed')}@example.com`;
      const res = await request.post('/auth/register', {
        data: { email, password: 'Password123!', firstName: 'T', lastName: 'C' },
        headers: { Cookie: `sm_ref=${value}` },
      });

      expect(
        res.ok(),
        `sm_ref=${value} broke registration: ${await res.text()}`,
      ).toBeTruthy();
    }
  });

  test('a click is recorded against the partner', async ({ request }) => {
    await track(request, partner.referralCode);

    // Click counting is fire-and-forget on purpose — a visitor's page load must
    // not wait on analytics — so the row appears shortly after the response.
    await expect
      .poll(
        async () => {
          const [row] = await sql<{ clicks: number }>(
            `SELECT "clicks" FROM "referral_clicks" WHERE "partnerId" = $1`,
            [partner.id],
          );
          return Number(row?.clicks ?? 0);
        },
        { timeout: 5_000 },
      )
      .toBeGreaterThanOrEqual(1);
  });

  test('a malformed code is rejected by validation, not passed to the lookup', async ({
    request,
  }) => {
    const tooLong = await request.post('/affiliate/track', {
      data: { code: 'X'.repeat(64) },
    });
    expect(tooLong.status()).toBe(400);

    const missing = await request.post('/affiliate/track', { data: {} });
    expect(missing.status()).toBe(400);
  });

  test('the partner sees their own referral in the portal', async ({
    request,
  }) => {
    const customer = await createCustomer(request, {
      referralCookie: partner.referralCode,
    });

    const res = await request.get('/partner/referrals', {
      headers: auth(partner.accessToken),
    });
    expect(res.ok(), await res.text()).toBeTruthy();

    const rows = await payload<{ userId?: string }[]>(res);
    expect(rows.length).toBe(1);

    // Whatever shape the row takes, it must not leak the referred customer's
    // email to the partner.
    expect(JSON.stringify(rows)).not.toContain(customer.email);
  });
});
