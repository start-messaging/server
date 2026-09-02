import { test, expect, APIResponse } from '@playwright/test';
import { createHash } from 'crypto';
import { resetDb, closeDb, sql } from '../helpers/db.js';
import {
  createAdmin,
  createCustomer,
  createPartner,
  updateSettings,
  payload,
  unique,
} from '../helpers/actors.js';
import {
  apiError,
  refreshCookie,
  register,
  splitRefreshCookie,
} from './helpers.js';

/**
 * The registration seam of `src/auth`: `/auth/register`, the RegisterDto the
 * global ValidationPipe runs over it, and the JWT strategy it hands the caller
 * a session from.
 *
 * auth/lifecycle covers the happy path; this file goes after what is left —
 * the fields a client must not be able to smuggle past the DTO, the
 * conversions `enableImplicitConversion` performs before a validator ever sees
 * the value, and the money a refused registration must not create.
 *
 * Budget note: `/auth/register` is throttled to 5 per minute per IP
 * (auth.controller.ts). `resetDb()` flushes the Redis counters, so the budget
 * is per test — every test below stays inside it except the one that
 * deliberately proves the limit.
 */

test.describe('registration edge cases', () => {
  test.beforeEach(async () => {
    await resetDb();
  });

  test.afterAll(async () => {
    await closeDb();
  });

  test('a second registration for the same person is a conflict and credits nothing', async ({
    request,
  }) => {
    // auth/lifecycle already pins that a duplicate (in either spelling) is
    // refused and leaves one row. What is new here is the money: the welcome
    // credit is the reason this matters beyond a status code, because a
    // duplicate that got through would hand the same person a second wallet
    // with another ten rupees in it. The exact 409/CONFLICT is pinned too —
    // tests/e2e/auth/lifecycle.spec.ts accepts 400 or 409, and the two are
    // not interchangeable to a client.
    const email = `${unique('dupe')}@example.com`;
    const first = await register(request, {
      email,
      password: 'Password123!',
      firstName: 'A',
      lastName: 'B',
    });
    expect(first.ok(), await first.text()).toBeTruthy();

    const second = await register(request, {
      email: email.toUpperCase(),
      password: 'Password123!',
      firstName: 'A',
      lastName: 'B',
    });
    expect(second.status(), await second.text()).toBe(409);
    expect((await apiError(second)).code).toBe('CONFLICT');

    const [{ users }] = await sql<{ users: string }>(
      `SELECT COUNT(*)::int AS users FROM "users" WHERE LOWER("email") = LOWER($1)`,
      [email],
    );
    expect(Number(users)).toBe(1);

    const [wallet] = await sql<{ balance: string; credits: string }>(
      `SELECT w."balance",
              (SELECT COUNT(*)::int FROM "wallet_transactions" t
                WHERE t."walletId" = w."id") AS credits
         FROM "wallets" w
         JOIN "users" u ON u."id" = w."userId"
        WHERE LOWER(u."email") = LOWER($1)`,
      [email],
    );
    expect(Number(wallet.balance)).toBe(10);
    expect(Number(wallet.credits)).toBe(1);
  });

  test('two identical registrations sent at once still produce one account', async ({
    request,
  }) => {
    // The duplicate check is a SELECT followed by an INSERT with nothing
    // holding the gap open (auth.service.ts:91-94 then :108), so two signups
    // from a double-clicked button can both find nothing and both insert.
    // UQ_users_email stops the second row existing — the question this asks is
    // what the caller is told when it does, because a QueryFailedError is not
    // an HttpException and reaches the filter as a 500 on a public endpoint.
    //
    // This half is deterministic whichever way the race falls: UQ_users_email
    // is what enforces it, so exactly one row survives even when both requests
    // get past the application check. What the loser is *told* is a separate
    // question, split into the test below because only that half is broken.
    const email = `${unique('race')}@example.com`;
    const body = {
      email,
      password: 'Password123!',
      firstName: 'A',
      lastName: 'B',
    };

    const [a, b] = await Promise.all([
      register(request, body),
      register(request, body),
    ]);

    expect([a, b].filter((res) => res.ok())).toHaveLength(1);

    const [{ users }] = await sql<{ users: string }>(
      `SELECT COUNT(*)::int AS users FROM "users" WHERE LOWER("email") = LOWER($1)`,
      [email],
    );
    expect(Number(users)).toBe(1);
  });

  test('the loser of a registration race is refused, not faulted', async ({
    request,
  }) => {
    // The loser answers 409, whichever way the race falls. If the two requests
    // serialise, the SELECT in auth.service catches it; if they overlap — the
    // ~100ms bcrypt hash between the SELECT and the INSERT is what holds that
    // window open — UQ_users_email catches it instead, and the service maps
    // that 23505 onto the same ConflictException. It used to escape as a raw
    // QueryFailedError and reach the filter as a 500, so a double-clicked
    // signup button read to the user as "the site is broken" rather than "you
    // already have an account".
    //
    // The mapping is deliberately narrowed to UQ_users_email: a 23505 from any
    // other constraint is a different fault and must not be reported here as a
    // taken email address.
    const email = `${unique('race')}@example.com`;
    const body = {
      email,
      password: 'Password123!',
      firstName: 'A',
      lastName: 'B',
    };

    const [a, b] = await Promise.all([
      register(request, body),
      register(request, body),
    ]);

    const refused = [a, b].filter((res) => !res.ok());
    expect(
      refused[0].status(),
      `the losing request answered ${refused[0].status()}: ${await refused[0].text()}`,
    ).toBe(409);
  });

  test('a mobile number already on another account is refused', async ({
    request,
  }) => {
    // Unique per run: mobileNumber has no unique constraint in the database,
    // so this check is the only thing keeping two accounts off one handset.
    const mobile = `+9198${String(Date.now()).slice(-8)}`;
    const first = await register(request, {
      email: `${unique('mob')}@example.com`,
      password: 'Password123!',
      firstName: 'A',
      lastName: 'B',
      mobileNumber: mobile,
    });
    expect(first.ok(), await first.text()).toBeTruthy();

    const takenEmail = `${unique('mob')}@example.com`;
    const second = await register(request, {
      email: takenEmail,
      password: 'Password123!',
      firstName: 'A',
      lastName: 'B',
      mobileNumber: mobile,
    });
    expect(second.status(), await second.text()).toBe(409);
    expect((await apiError(second)).code).toBe('CONFLICT');

    // The email was free, so the account must not exist half-made: the mobile
    // check runs before anything is written.
    const [{ users }] = await sql<{ users: string }>(
      `SELECT COUNT(*)::int AS users FROM "users" WHERE "email" = $1`,
      [takenEmail.toLowerCase()],
    );
    expect(Number(users)).toBe(0);
  });

  test('fields the DTO does not declare cannot be smuggled into a new account', async ({
    request,
  }) => {
    // whitelist is on and forbidNonWhitelisted is not (main.ts), so extras are
    // silently dropped rather than refused. Dropped is fine; reaching the
    // insert is not — `kycStatus: approved` would walk a brand-new account
    // straight past OnboardingGuard and onto the billable endpoints.
    const email = `${unique('smuggle')}@example.com`;
    const res = await register(request, {
      email,
      password: 'Password123!',
      firstName: 'A',
      lastName: 'B',
      id: '00000000-0000-4000-8000-0000000000ff',
      isActive: false,
      kycStatus: 'approved',
      mobileVerified: true,
      hasCompletedOnboarding: true,
      googleId: 'attacker-google-id',
      refreshTokenHash: 'attacker-controlled',
    });
    expect(res.ok(), await res.text()).toBeTruthy();

    const [row] = await sql<{
      id: string;
      role: string;
      isActive: boolean;
      kycStatus: string;
      mobileVerified: boolean;
      hasCompletedOnboarding: boolean;
      googleId: string | null;
      refreshTokenHash: string | null;
    }>(
      `SELECT "id", "role", "isActive", "kycStatus", "mobileVerified",
              "hasCompletedOnboarding", "googleId", "refreshTokenHash"
         FROM "users" WHERE "email" = $1`,
      [email.toLowerCase()],
    );

    expect(row.id).not.toBe('00000000-0000-4000-8000-0000000000ff');
    expect(row.role).toBe('customer');
    expect(row.isActive).toBe(true);
    expect(row.kycStatus).toBe('not_submitted');
    expect(row.mobileVerified).toBe(false);
    expect(row.hasCompletedOnboarding).toBe(false);
    expect(row.googleId).toBeNull();
    expect(row.refreshTokenHash).not.toBe('attacker-controlled');
  });

  test('a role outside the single permitted value is refused, and a null role means customer', async ({
    request,
  }) => {
    // RegisterDto pins the enum to [CUSTOMER], so `referrer` is as forbidden
    // as `admin` — a self-assigned referrer role would read partner routes.
    // tests/e2e/auth/lifecycle.spec.ts allows either "refused" or "silently
    // ignored" for role=admin; this pins which one it actually is, and covers
    // the value nobody thinks of.
    for (const role of ['admin', 'referrer']) {
      const res = await register(request, {
        email: `${unique('role')}@example.com`,
        password: 'Password123!',
        firstName: 'A',
        lastName: 'B',
        role,
      });
      expect(res.status(), `role "${role}" was accepted`).toBe(400);
      expect((await apiError(res)).code).toBe('VALIDATION_ERROR');
    }

    // null is not the same as a wrong value: @IsOptional skips validation for
    // null and undefined alike, so this is a plain customer signup.
    const email = `${unique('role')}@example.com`;
    const nulled = await register(request, {
      email,
      password: 'Password123!',
      firstName: 'A',
      lastName: 'B',
      role: null,
    });
    expect(nulled.ok(), await nulled.text()).toBeTruthy();

    const [row] = await sql<{ role: string }>(
      `SELECT "role" FROM "users" WHERE "email" = $1`,
      [email.toLowerCase()],
    );
    expect(row.role).toBe('customer');

    const [{ admins }] = await sql<{ admins: string }>(
      `SELECT COUNT(*)::int AS admins FROM "users" WHERE "role" <> 'customer'`,
    );
    expect(Number(admins)).toBe(0);
  });

  test('the password boundary is eight characters, and blank or absent is refused', async ({
    request,
  }) => {
    const cases: { label: string; password?: unknown; expected: number }[] = [
      { label: 'absent', expected: 400 },
      { label: 'empty', password: '', expected: 400 },
      { label: 'seven characters', password: '1234567', expected: 400 },
      { label: 'exactly eight', password: '12345678', expected: 201 },
    ];

    for (const { label, password, expected } of cases) {
      const data: Record<string, unknown> = {
        email: `${unique('pw')}@example.com`,
        firstName: 'A',
        lastName: 'B',
      };
      if (password !== undefined) data.password = password;

      const res = await register(request, data);
      expect(res.status(), `password ${label}: ${await res.text()}`).toBe(
        expected,
      );
      if (expected === 400) {
        expect((await apiError(res)).code).toBe('VALIDATION_ERROR');
      }
    }
  });

  test('a password that is not a string is not turned into one', async ({
    request,
  }) => {
    for (const [label, password] of [
      ['null', null],
      ['an array', ['Password', '123!']],
    ] as const) {
      const res = await register(request, {
        email: `${unique('pwtype')}@example.com`,
        password,
        firstName: 'A',
        lastName: 'B',
      });
      expect(res.status(), `password as ${label}: ${await res.text()}`).toBe(
        400,
      );
    }

    const [{ users }] = await sql<{ users: string }>(
      `SELECT COUNT(*)::int AS users FROM "users"`,
    );
    expect(Number(users)).toBe(0);
  });

  test('a JSON object cannot stand in for a password', async ({ request }) => {
    // The pipe runs with enableImplicitConversion (main.ts:33), and
    // class-transformer reaches its `targetType === String` branch before the
    // object branch (TransformOperationExecutor.transform), so `{}` becomes the
    // literal string "[object Object]" — fifteen characters, which sails past
    // @IsString and @MinLength(8). An array does not: `Array.isArray` is tested
    // first, which is why the test above still passes. Every account registered
    // this way would share one guessable password.
    //
    // RegisterDto now hands @IsString the raw value whenever the client sent an
    // object (RejectObjectCoercion), so the coercion never happens and the
    // request is a 400 with no row written. Numbers still coerce, because
    // register and login have to agree on what `password: 12345678` means.
    const email = `${unique('pwobj')}@example.com`;
    const res = await register(request, {
      email,
      password: { length: 12 },
      firstName: 'A',
      lastName: 'B',
    });

    expect(
      res.status(),
      `an object was accepted as a password: ${await res.text()}`,
    ).toBe(400);

    const [{ users }] = await sql<{ users: string }>(
      `SELECT COUNT(*)::int AS users FROM "users" WHERE "email" = $1`,
      [email.toLowerCase()],
    );
    expect(Number(users)).toBe(0);
  });

  test('an email that is blank, null or padded with spaces never reaches the database', async ({
    request,
  }) => {
    // AuthService trims and lowercases on the way in, but @IsEmail runs first
    // and validator.js does not tolerate surrounding whitespace — so a padded
    // address is a 400 and the service's trim never sees it. Worth pinning:
    // if the DTO ever loosens, that trim is the only thing standing between
    // " sam@x.com " and a second account for Sam.
    for (const [label, email] of [
      ['padded', ' padded@example.com '],
      ['empty', ''],
      ['null', null],
    ] as const) {
      const res = await register(request, {
        email,
        password: 'Password123!',
        firstName: 'A',
        lastName: 'B',
      });
      expect(res.status(), `email ${label}: ${await res.text()}`).toBe(400);
      expect((await apiError(res)).code).toBe('VALIDATION_ERROR');
    }

    const [{ users }] = await sql<{ users: string }>(
      `SELECT COUNT(*)::int AS users FROM "users"`,
    );
    expect(Number(users)).toBe(0);
  });

  test('a country code longer than the column is a bad request, not a server error', async ({
    request,
  }) => {
    // "country" is character varying(2) (InitialSchema.ts:50). A three-letter
    // code used to go to Postgres unchecked, come back as 22001, and reach the
    // exception filter as a plain QueryFailedError — not an HttpException, so
    // the filter answered 500 on an unauthenticated endpoint.
    //
    // RegisterDto now bounds the field to two letters, so this is a 400
    // VALIDATION_ERROR. The assertion stays at "below 500" rather than "400"
    // because what matters is that a caller with no credentials cannot turn a
    // signup into a 5xx.
    const email = `${unique('country')}@example.com`;
    const res = await register(request, {
      email,
      password: 'Password123!',
      firstName: 'A',
      lastName: 'B',
      country: 'IND',
    });

    expect(
      res.status(),
      `a three-letter country code answered ${res.status()}: ${await res.text()}`,
    ).toBeLessThan(500);

    // Whatever the status, no half-made account may survive it.
    const [{ users }] = await sql<{ users: string }>(
      `SELECT COUNT(*)::int AS users FROM "users" WHERE "email" = $1`,
      [email.toLowerCase()],
    );
    expect(Number(users)).toBe(0);
  });

  test('a name written in emoji or non-latin script survives the round trip', async ({
    request,
  }) => {
    const email = `${unique('utf8')}@example.com`;
    const firstName = '🙂 Ünïcødé';
    const lastName = '李';

    const res = await register(request, {
      email,
      password: 'Password123!',
      firstName,
      lastName,
    });
    expect(res.ok(), await res.text()).toBeTruthy();

    const body = await payload<{
      user: { firstName: string; lastName: string };
    }>(res);
    expect(body.user.firstName).toBe(firstName);
    expect(body.user.lastName).toBe(lastName);

    const [row] = await sql<{ firstName: string; lastName: string }>(
      `SELECT "firstName", "lastName" FROM "users" WHERE "email" = $1`,
      [email.toLowerCase()],
    );
    expect(row.firstName).toBe(firstName);
    expect(row.lastName).toBe(lastName);
  });

  test('the session cookie is HttpOnly, scoped to /auth, and only its hash is stored', async ({
    request,
  }) => {
    const email = `${unique('cookie')}@example.com`;
    const res = await register(request, {
      email,
      password: 'Password123!',
      firstName: 'A',
      lastName: 'B',
    });
    expect(res.ok(), await res.text()).toBeTruthy();

    const setCookie = res.headers()['set-cookie'] ?? '';
    expect(
      setCookie,
      'the refresh cookie was readable from JavaScript',
    ).toContain('HttpOnly');
    // Path=/auth is what keeps the refresh token off every other request, so
    // an XSS on a dashboard route cannot ride along with it.
    expect(setCookie).toContain('Path=/auth');
    expect(setCookie).toContain('SameSite=Lax');
    expect(setCookie).toContain('Max-Age=604800');

    const raw = refreshCookie(res.headers()) as string;
    const { userId, token } = splitRefreshCookie(raw);

    // The response body carries the access token only. A refresh token in the
    // JSON would be readable by any script on the page, which is the whole
    // point of putting it in an HttpOnly cookie instead.
    expect(await res.text()).not.toContain(token);

    const [row] = await sql<{ refreshTokenHash: string | null }>(
      `SELECT "refreshTokenHash" FROM "users" WHERE "id" = $1`,
      [userId],
    );
    expect(row.refreshTokenHash).toBe(
      createHash('sha256').update(token).digest('hex'),
    );
    expect(row.refreshTokenHash).not.toBe(token);
  });

  test('a referral code in the signup body attributes nobody', async ({
    request,
  }) => {
    // Attribution is read from the HttpOnly cookie the click endpoint set,
    // never from the body (auth.controller.ts readAttribution). A body-borne
    // code would let a partner credit themselves for signups they never sent.
    const admin = await createAdmin(request);
    const enabled = await updateSettings(request, admin.accessToken, {
      isEnabled: true,
    });
    expect(enabled.ok(), await enabled.text()).toBeTruthy();
    const partner = await createPartner(request);

    const smuggled = await register(request, {
      email: `${unique('body-ref')}@example.com`,
      password: 'Password123!',
      firstName: 'A',
      lastName: 'B',
      referralCode: partner.referralCode,
      partnerId: partner.id,
    });
    expect(smuggled.ok(), await smuggled.text()).toBeTruthy();

    const [{ referrals }] = await sql<{ referrals: string }>(
      `SELECT COUNT(*)::int AS referrals FROM "referrals"`,
    );
    expect(
      Number(referrals),
      'a referral was created from a client-supplied code',
    ).toBe(0);

    // Control: the same code in the cookie does attribute, so the assertion
    // above is about where the code came from and not about the programme
    // being switched off.
    const cookied = await createCustomer(request, {
      referralCookie: partner.referralCode,
    });
    const [row] = await sql<{ userId: string; partnerId: string }>(
      `SELECT "userId", "partnerId" FROM "referrals"`,
    );
    expect(row?.userId).toBe(cookied.id);
    expect(row?.partnerId).toBe(partner.id);
  });

  test('the sixth registration in a minute from one address is throttled', async ({
    request,
  }) => {
    // 5 per minute per IP (@Throttle on the handler). It is the only thing
    // between a scripted client and an unbounded number of accounts, each
    // carrying a ten-rupee welcome credit.
    const statuses: number[] = [];
    let last: APIResponse | null = null;
    for (let i = 0; i < 6; i += 1) {
      last = await register(request, {
        email: `${unique('flood')}@example.com`,
        password: 'Password123!',
        firstName: 'A',
        lastName: 'B',
      });
      statuses.push(last.status());
    }

    expect(
      statuses.slice(0, 5).every((s) => s < 300),
      `got ${statuses.join(', ')}`,
    ).toBe(true);
    expect(statuses[5], await (last as APIResponse).text()).toBe(429);

    // A rejected request must not have cost an account either way.
    const [{ users }] = await sql<{ users: string }>(
      `SELECT COUNT(*)::int AS users FROM "users"`,
    );
    expect(Number(users)).toBe(5);

    // The filter has no mapping for 429, so the code is currently the generic
    // INTERNAL_ERROR even though ErrorCodes.RATE_LIMIT_EXCEEDED exists. Either
    // is a defensible answer to "slow down"; a 5xx status would not be.
    expect(['RATE_LIMIT_EXCEEDED', 'INTERNAL_ERROR']).toContain(
      (await apiError(last as APIResponse)).code,
    );
  });
});
