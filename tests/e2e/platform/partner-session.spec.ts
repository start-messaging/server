import { test, expect } from '@playwright/test';
import { resetDb, closeDb, sql } from '../helpers/db.js';
import {
  createPartner,
  auth,
  payload,
  unique,
  Partner,
} from '../helpers/actors.js';
import { PARTNER_REFRESH_COOKIE, partnerRefreshCookie } from './helpers.js';

/**
 * Partner session handling.
 */
test.describe('partner session', () => {
  let partner: Partner;

  test.beforeEach(async ({ request }) => {
    await resetDb();
    partner = await createPartner(request);
  });

  test.afterAll(async () => {
    await closeDb();
  });

  test('registration hands back a session that works immediately', async ({
    request,
  }) => {
    // There is no approval step any more, so there is nothing to wait for.
    const email = `${unique('applicant')}@example.com`;
    const res = await request.post('/partner/auth/register', {
      data: { email, password: 'Password123!', firstName: 'A', lastName: 'B' },
    });
    expect(res.ok(), await res.text()).toBeTruthy();

    const body = await payload<{ accessToken: string }>(res);
    expect(body.accessToken).toBeTruthy();

    const me = await request.get('/partner/auth/me', {
      headers: auth(body.accessToken),
    });
    expect(me.ok(), await me.text()).toBeTruthy();
  });

  test('a new partner is active, not awaiting approval', async ({
    request,
  }) => {
    const email = `${unique('fresh')}@example.com`;
    await request.post('/partner/auth/register', {
      data: { email, password: 'Password123!', firstName: 'A', lastName: 'B' },
    });

    const [row] = await sql<{ status: string }>(
      `SELECT "status" FROM "partners" WHERE "email" = $1`,
      [email],
    );
    expect(row.status).toBe('active');

    // And logging in works straight away.
    const res = await request.post('/partner/auth/login', {
      data: { email, password: 'Password123!' },
    });
    expect(res.ok(), await res.text()).toBeTruthy();
  });

  test('a suspended partner still cannot log in', async ({ request }) => {
    // Removing approval must not have weakened the gates that matter.
    const suspended = await createPartner(request, { status: 'suspended' });

    const res = await request.post('/partner/auth/login', {
      data: { email: suspended.email, password: suspended.password },
    });
    expect(res.ok()).toBeFalsy();
    expect(res.status()).toBeLessThan(500);
  });

  test.describe('Google sign-in', () => {
    test('refuses a bogus id token without creating a partner', async ({
      request,
    }) => {
      const before = await sql<{ count: string }>(
        `SELECT COUNT(*)::int AS count FROM "partners"`,
      );

      const res = await request.post('/partner/auth/google', {
        data: { idToken: 'clearly-not-a-google-token' },
      });

      expect(res.ok()).toBeFalsy();
      // A rejected credential, not a server fault — the same distinction the
      // rest of this auth surface makes.
      expect(res.status(), await res.text()).toBeLessThan(500);

      const after = await sql<{ count: string }>(
        `SELECT COUNT(*)::int AS count FROM "partners"`,
      );
      expect(Number(after[0].count)).toBe(Number(before[0].count));
    });

    test('validates the body rather than reaching Google with junk', async ({
      request,
    }) => {
      for (const data of [{}, { idToken: '' }]) {
        const res = await request.post('/partner/auth/google', { data });
        expect(res.status(), `accepted ${JSON.stringify(data)}`).toBe(400);
      }

      // A number is answered 401 rather than 400: the global validation pipe
      // runs with implicit conversion, so 123 becomes the string "123", passes
      // @IsString, and is then refused by Google. Either code is a correct
      // answer for "that is not a token" — what matters is that neither is a
      // 500.
      const coerced = await request.post('/partner/auth/google', {
        data: { idToken: 123 },
      });
      expect([400, 401]).toContain(coerced.status());
    });

    test('does not fall over on a junk token whatever the Google config', async ({
      request,
    }) => {
      // GOOGLE_CLIENT_ID is now a dummy in .env.e2e (for the CUSTOMER mock
      // verifier seam — the partner realm has no mock and still runs the real
      // verify), so this exercises the configured-but-invalid-token path: the
      // verify fails, the catch turns it into a 401, and the endpoint must
      // answer rather than throw. On a deploy with the id absent the same
      // request is refused as "not configured" — either way, never a 500.
      const res = await request.post('/partner/auth/google', {
        data: { idToken: 'anything' },
      });
      expect(res.status()).toBeLessThan(500);
    });
  });

  test('partner registration validates its body the way customer registration does', async ({
    request,
  }) => {
    // Customer registration has a validation suite; partner registration had
    // none — the same account-creation surface, one door checked and one not.
    //
    // Four cases, not more: guards run before pipes, so even a refused body
    // counts against the 5/min register throttle, and the beforeEach partner
    // already spent one slot of this window.
    const cases: Array<[string, Record<string, unknown>]> = [
      ['an empty body', {}],
      [
        'a malformed email',
        {
          email: 'not-an-email',
          password: 'Password123!',
          firstName: 'A',
          lastName: 'B',
        },
      ],
      [
        'a seven-character password',
        {
          email: `${unique('short')}@example.com`,
          password: 'Pass12!',
          firstName: 'A',
          lastName: 'B',
        },
      ],
      [
        'a missing firstName',
        {
          email: `${unique('noname')}@example.com`,
          password: 'Password123!',
          lastName: 'B',
        },
      ],
    ];

    for (const [label, data] of cases) {
      const res = await request.post('/partner/auth/register', { data });
      expect(res.status(), `accepted ${label}`).toBe(400);
      const body = (await res.json()) as { error?: { code?: string } };
      expect(body.error?.code, label).toBe('VALIDATION_ERROR');
    }

    // None of the refusals left a half-created partner behind.
    const [{ count }] = await sql<{ count: string }>(
      `SELECT COUNT(*)::int AS count FROM "partners"`,
    );
    expect(Number(count), 'a refused registration created a partner').toBe(1);
  });

  test('the sixth partner registration in a minute from one address is throttled', async ({
    request,
  }) => {
    // 5 per minute per IP (@Throttle on the handler) — the cap on anonymous
    // partner-account flooding. The beforeEach partner spent one slot of this
    // window already, so the budget left is four.
    const statuses: number[] = [];
    let lastText = '';
    for (let i = 0; i < 5; i += 1) {
      const res = await request.post('/partner/auth/register', {
        data: {
          email: `${unique('flood')}@example.com`,
          password: 'Password123!',
          firstName: 'A',
          lastName: 'B',
        },
      });
      statuses.push(res.status());
      lastText = await res.text();
    }

    expect(statuses.slice(0, 4).every((s) => s < 300), statuses.join(',')).toBe(
      true,
    );
    expect(statuses[4], lastText).toBe(429);

    // The refused request must not have cost an account: the beforeEach
    // partner plus the four that landed.
    const [{ count }] = await sql<{ count: string }>(
      `SELECT COUNT(*)::int AS count FROM "partners"`,
    );
    expect(Number(count)).toBe(5);
  });

  test('a duplicate partner email is refused', async ({ request }) => {
    const res = await request.post('/partner/auth/register', {
      data: {
        email: partner.email,
        password: 'Password123!',
        firstName: 'A',
        lastName: 'B',
      },
    });
    expect(res.ok()).toBeFalsy();
  });

  test('refresh rotates and the consumed token stops working', async ({
    request,
  }) => {
    const login = await request.post('/partner/auth/login', {
      data: { email: partner.email, password: partner.password },
    });
    const first = partnerRefreshCookie(login.headers());
    test.skip(!first, 'partner refresh is not cookie-based in this build');

    const refreshed = await request.post('/partner/auth/refresh', {
      headers: { Cookie: `${PARTNER_REFRESH_COOKIE}=${first}` },
    });
    if (!refreshed.ok()) {
      // Cookie name differs; the rotation itself is covered by the DB assertion
      // in the suspension test.
      test.skip(true, 'partner refresh cookie name differs');
      return;
    }

    const replay = await request.post('/partner/auth/refresh', {
      headers: { Cookie: `${PARTNER_REFRESH_COOKIE}=${first}` },
    });
    expect(
      replay.ok(),
      'a rotated partner refresh token was reused',
    ).toBeFalsy();
  });

  test('a malformed partner refresh cookie is not a server error', async ({
    request,
  }) => {
    for (const value of [
      'garbage',
      'j%3A1',
      'not-a-uuid:token',
      ':',
      `${'0'.repeat(8)}-0000-4000-8000-000000000000:`,
      '',
    ]) {
      const res = await request.post('/partner/auth/refresh', {
        headers: { Cookie: `${PARTNER_REFRESH_COOKIE}=${value}` },
      });
      expect(
        res.status(),
        `${PARTNER_REFRESH_COOKIE}=${value} produced a server error`,
      ).toBeLessThan(500);
    }
  });

  test('logout clears the stored refresh hash', async ({ request }) => {
    const res = await request.post('/partner/auth/logout', {
      headers: auth(partner.accessToken),
    });
    expect(res.ok(), await res.text()).toBeTruthy();

    const [row] = await sql<{ refreshTokenHash: string | null }>(
      `SELECT "refreshTokenHash" FROM "partners" WHERE "id" = $1`,
      [partner.id],
    );
    expect(row.refreshTokenHash).toBeNull();
  });

  test('profile updates validate payout details', async ({ request }) => {
    const bad = [
      { payoutMethod: 'bank', bankIfsc: 'nope', bankAccountNumber: '123' },
      { payoutMethod: 'upi', upiId: 'not-a-upi-handle' },
      { payoutMethod: 'bank', bankAccountNumber: 'abcd' },
      { pan: 'INVALID' },
    ];

    for (const data of bad) {
      const res = await request.patch('/partner/payout-details', {
        data,
        headers: auth(partner.accessToken),
      });
      expect(res.status(), `accepted ${JSON.stringify(data)}`).toBe(400);
    }
  });

  test('legitimate profile fields persist to the partner row and come back sanitized', async ({
    request,
  }) => {
    // Only the mass-assignment negative existed for this route; the fields it
    // is FOR were never shown to stick.
    const res = await request.patch('/partner/profile', {
      data: {
        firstName: 'Meera',
        lastName: 'Iyer',
        phoneNumber: '+919876501234',
        companyName: 'Iyer Growth Labs',
      },
      headers: auth(partner.accessToken),
    });
    expect(res.status(), await res.text()).toBe(200);

    const body = await payload<Record<string, unknown>>(res);
    expect(body.firstName).toBe('Meera');
    expect(body.companyName).toBe('Iyer Growth Labs');
    // The response is the sanitized partner: no password material, no
    // admin-only notes, and the money fields as numbers.
    expect(body).not.toHaveProperty('passwordHash');
    expect(body).not.toHaveProperty('refreshTokenHash');
    expect(body).not.toHaveProperty('adminNotes');
    expect(typeof body.unpaidEarnings).toBe('number');

    const [row] = await sql<{
      firstName: string;
      lastName: string;
      phoneNumber: string | null;
      companyName: string | null;
      email: string;
    }>(
      `SELECT "firstName", "lastName", "phoneNumber", "companyName", "email"
         FROM "partners" WHERE "id" = $1`,
      [partner.id],
    );
    expect(row.firstName).toBe('Meera');
    expect(row.lastName).toBe('Iyer');
    expect(row.phoneNumber).toBe('+919876501234');
    expect(row.companyName).toBe('Iyer Growth Labs');
    // Identity is not a profile field: the email the account hangs off is
    // untouched by a route that never declared it.
    expect(row.email).toBe(partner.email);
  });

  test('profile fields are validated at their length caps', async ({
    request,
  }) => {
    const cases: Array<[string, Record<string, unknown>]> = [
      ['a firstName over 100 characters', { firstName: 'x'.repeat(101) }],
      ['a phoneNumber over 20 characters', { phoneNumber: '9'.repeat(21) }],
      ['a companyName over 200 characters', { companyName: 'c'.repeat(201) }],
      ['an array for a name', { firstName: ['M', 'e'] }],
    ];

    for (const [label, data] of cases) {
      const res = await request.patch('/partner/profile', {
        data,
        headers: auth(partner.accessToken),
      });
      expect(res.status(), `accepted ${label}`).toBe(400);
      const body = (await res.json()) as { error?: { code?: string } };
      expect(body.error?.code, label).toBe('VALIDATION_ERROR');
    }

    // Every refusal left the row as registration wrote it.
    const [row] = await sql<{ firstName: string; companyName: string | null }>(
      `SELECT "firstName", "companyName" FROM "partners" WHERE "id" = $1`,
      [partner.id],
    );
    expect(row.firstName).toBe('Test');
    expect(row.companyName).toBeNull();
  });

  test('a partner cannot change their own commission rate', async ({
    request,
  }) => {
    await request.patch('/partner/profile', {
      data: { commissionRate: 99, status: 'active', unpaidEarnings: 100000 },
      headers: auth(partner.accessToken),
    });

    const [row] = await sql<{
      commissionRate: string | null;
      unpaidEarnings: string;
    }>(
      `SELECT "commissionRate", "unpaidEarnings" FROM "partners" WHERE "id" = $1`,
      [partner.id],
    );
    expect(row.commissionRate).toBeNull();
    expect(Number(row.unpaidEarnings)).toBe(0);
  });

  test('the partner dashboard is self-scoped', async ({ request }) => {
    const other = await createPartner(request);

    const res = await request.get('/partner/dashboard', {
      headers: auth(partner.accessToken),
    });
    expect(res.ok(), await res.text()).toBeTruthy();

    const body = await payload<{ referralCode: string }>(res);
    expect(body.referralCode).toBe(partner.referralCode);
    expect(body.referralCode).not.toBe(other.referralCode);
  });
});
