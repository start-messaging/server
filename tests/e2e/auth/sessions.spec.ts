import { test, expect, APIRequestContext } from '@playwright/test';
import { createHash } from 'crypto';
import { resetDb, closeDb, sql } from '../helpers/db.js';
import {
  createAdmin,
  createCustomer,
  createPartner,
  auth,
  payload,
  unique,
  updateSettings,
} from '../helpers/actors.js';
import {
  JWT_SECRET,
  apiError,
  base64url,
  editClaims,
  mintToken,
  refreshCookie,
  register,
  session,
  splitRefreshCookie,
  withCookie,
} from './helpers.js';

/**
 * The session seam of `src/auth`: `/auth/refresh`, `/auth/logout`,
 * `/auth/google`, and the JWT strategy every other module trusts.
 *
 * auth/lifecycle covers the happy path and the rotation of the refresh
 * cookie; this file goes after what is left — token forgery and role
 * confusion.
 *
 * Budget note: `/auth/refresh` is throttled to 10 per minute per IP
 * (auth.controller.ts). `resetDb()` flushes the Redis counters, so the budget
 * is per test — every test below stays inside it.
 */

test.describe('session and token edge cases', () => {
  test.beforeEach(async () => {
    await resetDb();
  });

  test.afterAll(async () => {
    await closeDb();
  });

  test('a wrong refresh token for a real user destroys the real one', async ({
    request,
  }) => {
    // Presenting a token that does not match the stored hash is treated as a
    // stolen-token replay: the stored hash is cleared so neither the attacker
    // nor whoever holds the genuine cookie can renew. Losing the session is
    // the intended cost of that defence.
    const s = await session(request);

    const forged = await request.post('/auth/refresh', {
      headers: withCookie(`${s.id}:${'0'.repeat(64)}`),
    });
    expect(forged.status(), await forged.text()).toBe(401);
    expect((await apiError(forged)).code).toBe('UNAUTHORIZED');

    const [row] = await sql<{ refreshTokenHash: string | null }>(
      `SELECT "refreshTokenHash" FROM "users" WHERE "id" = $1`,
      [s.id],
    );
    expect(row.refreshTokenHash).toBeNull();

    const genuine = await request.post('/auth/refresh', {
      headers: withCookie(s.raw),
    });
    expect(
      genuine.status(),
      'the genuine cookie still worked after a replay attempt',
    ).toBe(401);
  });

  test('a refresh cookie for a deactivated account is refused and burns the stored token', async ({
    request,
  }) => {
    const s = await session(request);
    await sql(`UPDATE "users" SET "isActive" = false WHERE "id" = $1`, [s.id]);

    const res = await request.post('/auth/refresh', {
      headers: withCookie(s.raw),
    });
    expect(res.status(), await res.text()).toBe(401);

    // Not merely refused: the stored hash is cleared, so reinstating the
    // account does not silently revive a session issued before it was
    // switched off.
    const [row] = await sql<{ refreshTokenHash: string | null }>(
      `SELECT "refreshTokenHash" FROM "users" WHERE "id" = $1`,
      [s.id],
    );
    expect(row.refreshTokenHash).toBeNull();
  });

  test('an access token is not a refresh token, and a refresh token is not an access token', async ({
    request,
  }) => {
    const s = await session(request);

    // The refresh token is 32 random bytes, not a JWT — presenting it as a
    // bearer credential must fail at the signature, not be waved through.
    const asBearer = await request.post('/auth/logout', {
      headers: auth(s.token),
    });
    expect(asBearer.status(), await asBearer.text()).toBe(401);
    expect((await apiError(asBearer)).code).toBe('UNAUTHORIZED');

    // And the reverse: the access token hashes to something that is not the
    // stored refresh hash, so it cannot renew a session.
    const asCookie = await request.post('/auth/refresh', {
      headers: withCookie(`${s.id}:${s.accessToken}`),
    });
    expect(asCookie.status(), await asCookie.text()).toBe(401);
  });

  test('two refreshes racing on one cookie leave that cookie dead', async ({
    request,
  }) => {
    // A page that fires two API calls at once refreshes twice with the same
    // cookie. Both may be answered — but the cookie they were built from must
    // be spent either way, or a stolen copy stays useful.
    const s = await session(request);

    const [a, b] = await Promise.all([
      request.post('/auth/refresh', { headers: withCookie(s.raw) }),
      request.post('/auth/refresh', { headers: withCookie(s.raw) }),
    ]);

    for (const res of [a, b]) {
      expect(res.status(), await res.text()).toBeLessThan(500);
    }
    expect([a, b].filter((res) => res.ok()).length).toBeGreaterThanOrEqual(1);

    const replay = await request.post('/auth/refresh', {
      headers: withCookie(s.raw),
    });
    expect(replay.ok(), 'the consumed cookie was still accepted').toBeFalsy();
  });

  test('logging out twice is not an error', async ({ request }) => {
    const s = await session(request);

    const first = await request.post('/auth/logout', {
      headers: auth(s.accessToken),
    });
    expect(first.ok(), await first.text()).toBeTruthy();

    // The access token is still valid for its full life, so the second call is
    // a no-op on a row that is already cleared — it must not 404 or 500.
    const second = await request.post('/auth/logout', {
      headers: auth(s.accessToken),
    });
    expect(second.ok(), await second.text()).toBeTruthy();

    const [row] = await sql<{ refreshTokenHash: string | null }>(
      `SELECT "refreshTokenHash" FROM "users" WHERE "id" = $1`,
      [s.id],
    );
    expect(row.refreshTokenHash).toBeNull();
  });

  test('logout cannot be aimed at another account through the body', async ({
    request,
  }) => {
    // The handler takes the id from req.user and nothing else. A body that
    // named someone else would be a free unauthenticated logout for any user
    // id an attacker could name.
    const victim = await session(request);
    const attacker = await session(request);

    const res = await request.post('/auth/logout', {
      data: { userId: victim.id, id: victim.id, sub: victim.id },
      headers: auth(attacker.accessToken),
    });
    expect(res.ok(), await res.text()).toBeTruthy();

    const [row] = await sql<{ refreshTokenHash: string | null }>(
      `SELECT "refreshTokenHash" FROM "users" WHERE "id" = $1`,
      [victim.id],
    );
    expect(row.refreshTokenHash).not.toBeNull();

    const stillGood = await request.post('/auth/refresh', {
      headers: withCookie(victim.raw),
    });
    expect(stillGood.ok(), await stillGood.text()).toBeTruthy();
  });

  test('a second login makes the first session cookie useless', async ({
    request,
  }) => {
    // One refreshTokenHash column per user, so signing in again anywhere ends
    // the older session. Worth pinning: the day this becomes a multi-session
    // store, "log out everywhere" quietly stops working.
    const s = await session(request);

    const again = await request.post('/auth/login', {
      data: { email: s.email, password: 'Password123!' },
    });
    expect(again.ok(), await again.text()).toBeTruthy();
    const newer = refreshCookie(again.headers()) as string;
    expect(newer).not.toBe(s.raw);

    // Read the column rather than spending the old cookie to prove the point.
    // `refreshTokens` treats any token that does not match the stored hash as a
    // replay and clears the column (auth.service.ts:242-247), so presenting the
    // first login's cookie here would revoke the *second* login's session as a
    // side effect — and the "the current session still works" assertion below
    // would then fail for a reason that has nothing to do with this test.
    const hash = (raw: string) =>
      createHash('sha256').update(splitRefreshCookie(raw).token).digest('hex');
    const [row] = await sql<{ refreshTokenHash: string | null }>(
      `SELECT "refreshTokenHash" FROM "users" WHERE "id" = $1`,
      [s.id],
    );
    expect(row.refreshTokenHash).toBe(hash(newer));
    expect(
      row.refreshTokenHash,
      'the first login cookie was still the stored credential',
    ).not.toBe(hash(s.raw));

    const current = await request.post('/auth/refresh', {
      headers: withCookie(newer),
    });
    expect(current.ok(), await current.text()).toBeTruthy();

    // Last, because it is the call that burns whatever is stored.
    const older = await request.post('/auth/refresh', {
      headers: withCookie(s.raw),
    });
    expect(
      older.ok(),
      'the cookie from the first login still renewed the session',
    ).toBeFalsy();
  });

  test('editing the claims inside a real token does not grant them', async ({
    request,
  }) => {
    // The JWT strategy trusts `role` and `sub` verbatim — it never reloads the
    // user — so the signature is the only thing standing between a customer
    // and an admin session.
    const customer = await createCustomer(request);

    for (const [label, patch] of [
      ['a promoted role', { role: 'admin' }],
      ['someone else id', { sub: '00000000-0000-4000-8000-000000000001' }],
      ['a stretched expiry', { exp: Math.floor(Date.now() / 1000) + 86_400 }],
    ] as const) {
      const res = await request.post('/auth/logout', {
        headers: auth(editClaims(customer.accessToken, patch)),
      });
      expect(res.status(), `${label} was accepted`).toBe(401);
      expect((await apiError(res)).code).toBe('UNAUTHORIZED');
    }
  });

  test('a token signed with another secret, or with no algorithm at all, is refused', async ({
    request,
  }) => {
    const claims = {
      sub: '00000000-0000-4000-8000-000000000002',
      email: 'forged@example.com',
      role: 'admin',
    };

    const forgeries: [string, string][] = [
      ['a wrong secret', mintToken(claims, 'not-the-signing-key')],
      ['alg none', mintToken(claims, '', 'none')],
      [
        'an empty signature',
        mintToken(claims, JWT_SECRET).replace(/\.[^.]*$/, '.'),
      ],
    ];

    for (const [label, token] of forgeries) {
      const res = await request.post('/auth/logout', { headers: auth(token) });
      expect(res.status(), `${label} was accepted`).toBe(401);
    }
  });

  test('an expired token is refused although its signature is still valid', async ({
    request,
  }) => {
    const customer = await createCustomer(request);
    const now = Math.floor(Date.now() / 1000);
    const claims = {
      sub: customer.id,
      email: customer.email,
      role: 'customer',
    };

    // Control first: if this suite is not signing with the server's own
    // secret, the expiry assertion below would pass for the wrong reason.
    const live = await request.post('/auth/logout', {
      headers: auth(
        mintToken({ ...claims, iat: now, exp: now + 300 }, JWT_SECRET),
      ),
    });
    test.skip(
      !live.ok(),
      'the suite is not signing with the server JWT_SECRET; expiry is untestable here',
    );

    const expired = await request.post('/auth/logout', {
      headers: auth(
        mintToken({ ...claims, iat: now - 7200, exp: now - 3600 }, JWT_SECRET),
      ),
    });
    expect(expired.status(), await expired.text()).toBe(401);
  });

  test('promoting a user in the database does not upgrade the token they already hold', async ({
    request,
  }) => {
    // RolesGuard reads the role off the JWT payload, never off the row, so a
    // promotion only takes effect once a new token is issued. That is the
    // behaviour every admin route depends on — and its mirror image is the
    // risk worth remembering: a demotion likewise waits for the token to
    // expire.
    const customer = await createCustomer(request);

    const before = await request.get('/admin/users', {
      headers: auth(customer.accessToken),
    });
    expect(before.status(), await before.text()).toBe(403);
    expect((await apiError(before)).code).toBe('FORBIDDEN');

    await sql(`UPDATE "users" SET "role" = 'admin' WHERE "id" = $1`, [
      customer.id,
    ]);

    const stale = await request.get('/admin/users', {
      headers: auth(customer.accessToken),
    });
    expect(
      stale.status(),
      'a token minted for a customer opened an admin route',
    ).toBe(403);

    const login = await request.post('/auth/login', {
      data: { email: customer.email, password: customer.password },
    });
    const fresh = await payload<{ accessToken: string }>(login);
    const after = await request.get('/admin/users', {
      headers: auth(fresh.accessToken),
    });
    expect(after.status(), await after.text()).toBe(200);
  });

  test('a demoted admin cannot reach admin routes with a newly issued token', async ({
    request,
  }) => {
    // The mirror of the test above, and the half that carries risk: because
    // the role is read off the token, the access token an admin was holding
    // when they were demoted keeps opening admin routes until it expires.
    // Only the newly issued token is asserted here — the stale-token window
    // is reported rather than pinned, since pinning it would mean writing a
    // test that fails the day it is closed.
    const admin = await createAdmin(request);
    const asAdmin = await request.get('/admin/users', {
      headers: auth(admin.accessToken),
    });
    expect(asAdmin.status(), await asAdmin.text()).toBe(200);

    await sql(`UPDATE "users" SET "role" = 'customer' WHERE "id" = $1`, [
      admin.id,
    ]);

    const login = await request.post('/auth/login', {
      data: { email: admin.email, password: admin.password },
    });
    const demoted = await payload<{
      accessToken: string;
      user: { role: string };
    }>(login);
    expect(demoted.user.role).toBe('customer');

    const res = await request.get('/admin/users', {
      headers: auth(demoted.accessToken),
    });
    expect(res.status(), await res.text()).toBe(403);
  });

  test('google sign-in validates its body and creates nobody when it fails', async ({
    request,
  }) => {
    // This environment runs the mock verifier (GOOGLE_MOCK_VERIFY, .env.e2e),
    // which refuses anything that is not a `mock:` token with the very 401 a
    // bad live token gets — so these malformed bodies hit the same wall a
    // deploy with real Google keys puts up: the endpoint must answer, not
    // throw, and must never leave a half-made account behind.
    const cases: Record<string, unknown>[] = [
      {},
      { idToken: null },
      { idToken: 'anything', role: 'admin' },
      { idToken: 'anything', country: 'IND' },
    ];

    for (const data of cases) {
      const res = await request.post('/auth/google', { data });
      expect(
        res.status(),
        `${JSON.stringify(data)} produced a server error: ${await res.text()}`,
      ).toBeLessThan(500);
      expect(res.ok(), `${JSON.stringify(data)} was accepted`).toBeFalsy();
    }

    const [{ users }] = await sql<{ users: string }>(
      `SELECT COUNT(*)::int AS users FROM "users"`,
    );
    expect(Number(users)).toBe(0);
  });

  test('google sign-in refuses an oversized country code before it refuses the token', async ({
    request,
  }) => {
    // The test above accepts any non-500 for `country: "IND"`, and it used to
    // pass for the wrong reason: with no Google config the service answered
    // 401 before the row was ever inserted. Configure Google (as this
    // environment now does, via the mock verifier) and an unbounded body
    // would have gone on to Postgres, where country is character varying(2),
    // and come back as the 22001 → 500 that register already had fixed.
    //
    // Which status comes back is the whole point, because the two failures sit
    // on either side of the insert. The global ValidationPipe runs on the body
    // in the pipes phase, before the handler and therefore before
    // AuthService.googleAuth can refuse the token — so a bounded DTO answers
    // 400 here whatever the Google config is, while an unbounded one can only
    // ever manage 401. The second case is the control: a well-formed country
    // gets past the DTO and is refused as a bad token (the mock verifier
    // rejects anything that is not `mock:`-shaped with the same 401), which
    // is what proves the 400 above came from the country and not from the
    // route being broken.
    const refused = await request.post('/auth/google', {
      data: { idToken: 'anything', country: 'IND' },
    });
    expect(
      refused.status(),
      `a three-letter country was not refused by the DTO: ${await refused.text()}`,
    ).toBe(400);
    expect((await apiError(refused)).code).toBe('VALIDATION_ERROR');

    const accepted = await request.post('/auth/google', {
      data: { idToken: 'anything', country: 'in' },
    });
    expect(
      accepted.status(),
      `a two-letter country was refused by the DTO: ${await accepted.text()}`,
    ).toBe(401);

    const [{ users }] = await sql<{ users: string }>(
      `SELECT COUNT(*)::int AS users FROM "users"`,
    );
    expect(Number(users)).toBe(0);
  });
});

/**
 * The Google success paths, through the mock verifier.
 *
 * GOOGLE_MOCK_VERIFY in .env.e2e (double-locked in AuthService on
 * NODE_ENV=test) makes googleAuth accept `mock:<base64url JSON>` id tokens;
 * everything past the verification — lookup, linking, creation, the welcome
 * credit, attribution, the cookie — is the real code. A real Google token, or
 * any other shape, still gets the same 401 a bad token gets, which is what
 * keeps the failure tests above meaningful.
 */
test.describe('google sign-in through the mock verifier', () => {
  test.beforeEach(async () => {
    await resetDb();
  });

  test.afterAll(async () => {
    await closeDb();
  });

  const mockGoogleToken = (identity: {
    sub: string;
    email: string;
    given_name?: string;
    family_name?: string;
  }) =>
    `mock:${base64url(JSON.stringify({ email_verified: true, ...identity }))}`;

  const googleAuth = (
    request: APIRequestContext,
    identity: Parameters<typeof mockGoogleToken>[0],
    headers: Record<string, string> = {},
  ) =>
    request.post('/auth/google', {
      data: { idToken: mockGoogleToken(identity) },
      headers,
    });

  test('a first sign-in creates the account and says isNewUser exactly once', async ({
    request,
  }) => {
    const email = `${unique('goog')}@example.com`;

    const first = await googleAuth(request, {
      sub: 'goog-sub-1',
      email,
      given_name: 'Gee',
      family_name: 'Oogle',
    });
    expect(first.status(), await first.text()).toBe(201);

    // isNewUser is the flag the dashboard aliases analytics identities on —
    // it must be present (and true) only on the call that created the row.
    const body = await payload<{
      accessToken: string;
      isNewUser?: boolean;
      user: { id: string; email: string };
    }>(first);
    expect(body.isNewUser).toBe(true);
    expect(body.user.email).toBe(email);

    const rows = await sql<{
      id: string;
      googleId: string | null;
      passwordHash: string | null;
      role: string;
      firstName: string;
      lastName: string;
    }>(
      `SELECT "id", "googleId", "passwordHash", "role", "firstName", "lastName"
         FROM "users"`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(body.user.id);
    expect(rows[0].googleId).toBe('goog-sub-1');
    expect(rows[0].passwordHash).toBeNull();
    expect(rows[0].role).toBe('customer');
    expect(rows[0].firstName).toBe('Gee');
    expect(rows[0].lastName).toBe('Oogle');

    // The same ten-rupee welcome credit a password registration gets.
    const [wallet] = await sql<{ balance: string }>(
      `SELECT "balance" FROM "wallets" WHERE "userId" = $1`,
      [body.user.id],
    );
    expect(Number(wallet?.balance)).toBe(10);

    // The SAME identity signing in again is a login, not a signup: no
    // isNewUser in the body (absent, not false — the controller only spreads
    // it in when the account was created), and no second row.
    const again = await googleAuth(request, { sub: 'goog-sub-1', email });
    expect(again.status(), await again.text()).toBe(201);
    const againBody = await payload<Record<string, unknown>>(again);
    expect('isNewUser' in againBody).toBe(false);
    expect((againBody.user as { id: string }).id).toBe(body.user.id);

    const [{ users }] = await sql<{ users: string }>(
      `SELECT COUNT(*)::int AS users FROM "users"`,
    );
    expect(Number(users)).toBe(1);
  });

  test('a known email is linked onto the existing password account, not duplicated', async ({
    request,
  }) => {
    // UQ_users_googleId's whole purpose: the person who registered with a
    // password and later clicks "Sign in with Google" must land in the same
    // account, with both doors still open.
    const customer = await createCustomer(request);

    const res = await googleAuth(request, {
      sub: 'goog-link-1',
      email: customer.email,
    });
    expect(res.status(), await res.text()).toBe(201);

    const body = await payload<Record<string, unknown>>(res);
    // Linking is a login of an existing account — never a signup.
    expect('isNewUser' in body).toBe(false);
    expect((body.user as { id: string }).id).toBe(customer.id);

    const rows = await sql<{
      id: string;
      googleId: string | null;
      passwordHash: string | null;
    }>(`SELECT "id", "googleId", "passwordHash" FROM "users"`);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(customer.id);
    expect(rows[0].googleId).toBe('goog-link-1');
    expect(rows[0].passwordHash).not.toBeNull();

    // Both credentials open the one account.
    const login = await request.post('/auth/login', {
      data: { email: customer.email, password: customer.password },
    });
    expect(login.ok(), await login.text()).toBeTruthy();
  });

  test('the google refresh cookie carries the same attributes as the password doors', async ({
    request,
  }) => {
    const viaRegister = await register(request, {
      email: `${unique('goog-reg')}@example.com`,
      password: 'Password123!',
      firstName: 'A',
      lastName: 'B',
    });
    expect(viaRegister.ok(), await viaRegister.text()).toBeTruthy();

    const viaGoogle = await googleAuth(request, {
      sub: 'goog-cookie-1',
      email: `${unique('goog-cookie')}@example.com`,
    });
    expect(viaGoogle.ok(), await viaGoogle.text()).toBeTruthy();

    // Compared attribute-for-attribute against the register cookie rather
    // than against literals, so the two doors cannot drift apart silently.
    // The value and Expires are stripped: the token differs by design, and
    // Expires is Max-Age restated relative to "now".
    const attrs = (headers: Record<string, string>) => {
      const line =
        (headers['set-cookie'] ?? '')
          .split('\n')
          .find((l) => l.includes('refresh_token=')) ?? '';
      return line
        .split(';')
        .map((s) => s.trim())
        .filter(
          (s) => !s.startsWith('refresh_token=') && !s.startsWith('Expires='),
        )
        .sort();
    };
    expect(attrs(viaGoogle.headers())).toEqual(attrs(viaRegister.headers()));
    // And the substance, so equal-but-both-empty can never pass.
    expect(attrs(viaGoogle.headers())).toEqual(
      expect.arrayContaining([
        'HttpOnly',
        'Path=/auth',
        'SameSite=Lax',
        'Max-Age=604800',
      ]),
    );
  });

  test('a referral cookie attributes a first google sign-in; a body-borne code attributes nobody', async ({
    request,
  }) => {
    // Mirrors the register-side test in auth/registration.spec.ts: the code
    // must come from the HttpOnly sm_ref cookie the click endpoint set, never
    // from the request body — a client-supplied code would let a partner
    // credit themselves for signups they never sent.
    const admin = await createAdmin(request);
    const enabled = await updateSettings(request, admin.accessToken, {
      isEnabled: true,
    });
    expect(enabled.ok(), await enabled.text()).toBeTruthy();
    const partner = await createPartner(request);

    const smuggled = await request.post('/auth/google', {
      data: {
        idToken: mockGoogleToken({
          sub: 'goog-ref-1',
          email: `${unique('goog-smuggle')}@example.com`,
        }),
        referralCode: partner.referralCode,
        partnerId: partner.id,
      },
    });
    expect(smuggled.status(), await smuggled.text()).toBe(201);

    const [{ referrals }] = await sql<{ referrals: string }>(
      `SELECT COUNT(*)::int AS referrals FROM "referrals"`,
    );
    expect(
      Number(referrals),
      'a referral was created from a client-supplied code',
    ).toBe(0);

    // Control: the same code in the cookie attributes exactly as
    // /auth/register does — one row, this user, this partner.
    const cookied = await googleAuth(
      request,
      { sub: 'goog-ref-2', email: `${unique('goog-cookie-ref')}@example.com` },
      { Cookie: `sm_ref=${partner.referralCode}` },
    );
    expect(cookied.status(), await cookied.text()).toBe(201);
    const cookiedBody = await payload<{
      isNewUser?: boolean;
      user: { id: string };
    }>(cookied);
    expect(cookiedBody.isNewUser).toBe(true);

    const rows = await sql<{ userId: string; partnerId: string }>(
      `SELECT "userId", "partnerId" FROM "referrals"`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].userId).toBe(cookiedBody.user.id);
    expect(rows[0].partnerId).toBe(partner.id);
  });
});

/**
 * The unverified-email door into an existing customer account.
 *
 * `POST /auth/google` step 2 links a Google identity onto an account matched on
 * email alone, and Google will assert an address it has not confirmed. Until
 * this was fixed the customer path read `payload.email` and never
 * `payload.email_verified`, so a genuine, correctly-audienced token carrying
 * someone else's unverified address was enough to weld an attacker's googleId
 * onto that account and be handed a session plus a 7-day refresh cookie.
 *
 * PartnerAuthService.googleAuth has always refused these. This pins that the
 * customer door — the one guarding the wallet, the API keys and the message
 * history — refuses them identically, so the two cannot drift apart again.
 */
test.describe('google sign-in refuses an unverified email', () => {
  test.beforeEach(async () => {
    await resetDb();
  });

  test.afterAll(async () => {
    await closeDb();
  });

  const unverifiedToken = (identity: { sub: string; email: string }) =>
    `mock:${base64url(JSON.stringify({ ...identity, email_verified: false }))}`;

  test('it cannot be linked onto an existing account', async ({ request }) => {
    const victim = await createCustomer(request);

    const res = await request.post('/auth/google', {
      data: {
        idToken: unverifiedToken({ sub: 'attacker-sub', email: victim.email }),
      },
    });
    expect(res.status(), await res.text()).toBe(401);

    // No session, and — the part that matters — no googleId welded on, which
    // would have been a permanent second door surviving a password change.
    const [row] = await sql<{ googleId: string | null }>(
      `SELECT "googleId" FROM "users" WHERE "id" = $1`,
      [victim.id],
    );
    expect(row.googleId).toBeNull();
  });

  test('it cannot create a new account either', async ({ request }) => {
    const email = `${unique('unverified')}@example.com`;

    const res = await request.post('/auth/google', {
      data: { idToken: unverifiedToken({ sub: 'new-attacker-sub', email }) },
    });
    expect(res.status(), await res.text()).toBe(401);

    const rows = await sql(`SELECT "id" FROM "users" WHERE "email" = $1`, [
      email,
    ]);
    expect(rows).toHaveLength(0);
  });

  test('a token with no email_verified claim at all is refused', async ({
    request,
  }) => {
    // Absent is not the same as false, and both must fail closed — a claim
    // Google omits must never read as "verified".
    const email = `${unique('noclaim')}@example.com`;
    const res = await request.post('/auth/google', {
      data: {
        idToken: `mock:${base64url(JSON.stringify({ sub: 'no-claim-sub', email }))}`,
      },
    });
    expect(res.status(), await res.text()).toBe(401);

    const rows = await sql(`SELECT "id" FROM "users" WHERE "email" = $1`, [
      email,
    ]);
    expect(rows).toHaveLength(0);
  });
});
