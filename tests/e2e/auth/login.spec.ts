import { test, expect, APIResponse } from '@playwright/test';
import { resetDb, closeDb, flushRedis, sql } from '../helpers/db.js';
import { createCustomer, seedCustomer, unique } from '../helpers/actors.js';
import { apiError, refreshCookie, register } from './helpers.js';

/**
 * The login seam of `src/auth`: `/auth/login`, the LoginDto the global
 * ValidationPipe runs over it, and the session it is allowed to hand back.
 *
 * auth/lifecycle covers the happy path; this file goes after what is left —
 * the accounts that must never be let in, and the conversions
 * `enableImplicitConversion` performs before a validator ever sees the value.
 *
 * Budget note: `/auth/login` is throttled to 5 per minute per IP
 * (auth.controller.ts). `resetDb()` flushes the Redis counters, so the budget
 * is per test — every test below stays inside it.
 */

test.describe('login edge cases', () => {
  test.beforeEach(async () => {
    await resetDb();
  });

  test.afterAll(async () => {
    await closeDb();
  });

  test('a deactivated account cannot log in and is handed no session', async ({
    request,
  }) => {
    const customer = await createCustomer(request);
    await sql(`UPDATE "users" SET "isActive" = false WHERE "id" = $1`, [
      customer.id,
    ]);

    const res = await request.post('/auth/login', {
      data: { email: customer.email, password: customer.password },
    });
    expect(res.status(), await res.text()).toBe(401);
    expect((await apiError(res)).code).toBe('UNAUTHORIZED');

    // No token, and no cookie either — a refused login must not rotate a
    // session into existence for an account that has been switched off.
    expect(refreshCookie(res.headers())).toBeNull();
    expect(await res.text()).not.toContain('accessToken');
  });

  test('an account with no password is refused rather than logged in', async ({
    request,
  }) => {
    // Google sign-ups (and seeded rows) carry passwordHash NULL. The service
    // checks for that before it compares, because a bcrypt comparison against
    // nothing must never be allowed to succeed. It also answers with a message
    // of its own rather than the generic "Invalid credentials", which does
    // tell a caller the address exists — noted rather than pinned here, since
    // the hint is arguably deliberate.
    const seeded = await seedCustomer();

    const res = await request.post('/auth/login', {
      data: { email: seeded.email, password: 'Password123!' },
    });
    expect(res.status(), await res.text()).toBe(401);
    expect(refreshCookie(res.headers())).toBeNull();

    const [row] = await sql<{ refreshTokenHash: string | null }>(
      `SELECT "refreshTokenHash" FROM "users" WHERE "id" = $1`,
      [seeded.id],
    );
    expect(row.refreshTokenHash).toBeNull();
  });

  test('the login body is validated before any credential is checked', async ({
    request,
  }) => {
    const cases: { label: string; data: Record<string, unknown> }[] = [
      { label: 'empty body', data: {} },
      { label: 'no password', data: { email: 'someone@example.com' } },
      { label: 'no email', data: { password: 'Password123!' } },
      {
        label: 'an object for an email',
        data: { email: { $ne: null }, password: 'Password123!' },
      },
    ];

    for (const { label, data } of cases) {
      const res = await request.post('/auth/login', { data });
      expect(res.status(), `${label}: ${await res.text()}`).toBe(400);
      expect((await apiError(res)).code).toBe('VALIDATION_ERROR');
    }
  });

  test('a JSON object sent as a password is a bad request, not a failed credential check', async ({
    request,
  }) => {
    // The hole the register side already closed, closed here too: with
    // enableImplicitConversion (main.ts:33) class-transformer flattens an
    // object to the literal "[object Object]" before @IsString looks at it, so
    // LoginDto used to accept `{ "$ne": null }` as a password and hand it to
    // bcrypt. bcrypt could never match it, which is why nothing broke — but
    // the two DTOs disagreed about what a password is, and the answer a client
    // got said "wrong password" when the truth was "that is not a password".
    //
    // The code is what this test is really about: a genuinely wrong password
    // is a 4xx as well, so only VALIDATION_ERROR distinguishes a body refused
    // at the door from a credential that was actually compared. The account
    // exists and its real password is known, so a 401 here would mean the
    // object reached the comparison.
    const customer = await createCustomer(request);

    const res = await request.post('/auth/login', {
      data: { email: customer.email, password: { length: 12 } },
    });

    expect(
      res.status(),
      `an object reached the credential check: ${await res.text()}`,
    ).toBe(400);
    expect((await apiError(res)).code).toBe('VALIDATION_ERROR');
    expect(refreshCookie(res.headers())).toBeNull();
  });

  test('a password sent as a number is the same credential at both ends', async ({
    request,
  }) => {
    // enableImplicitConversion turns 12345678 into "12345678" before any
    // validator sees it, at registration and at login alike. The two ends have
    // to agree: if the conversion is ever switched off, everybody who signed
    // up with a numeric password is locked out of their account.
    //
    // Which is the line RejectObjectCoercion walks on both DTOs: it hands the
    // validator the raw value only when the client sent an object, so numbers
    // go on coercing exactly as they always did. This test is what stops that
    // transform from being widened into "reject anything that is not a
    // string" — a change that would read as a tightening and lock people out.
    const email = `${unique('numeric')}@example.com`;
    const created = await register(request, {
      email,
      password: 12345678,
      firstName: 'A',
      lastName: 'B',
    });
    expect(created.ok(), await created.text()).toBeTruthy();

    const asNumber = await request.post('/auth/login', {
      data: { email, password: 12345678 },
    });
    expect(asNumber.ok(), await asNumber.text()).toBeTruthy();

    const asString = await request.post('/auth/login', {
      data: { email, password: '12345678' },
    });
    expect(asString.ok(), await asString.text()).toBeTruthy();
  });

  test('the sixth password guess in a minute is throttled, and the account is not locked out', async ({
    request,
  }) => {
    // 5 per minute per IP (@Throttle on the handler) — the only thing between
    // a scripted client and unlimited password guesses. Same shape as the
    // register test in registration.spec.ts; both decorators carry the same
    // numbers, and either could be deleted without the other's test noticing.
    const customer = await createCustomer(request);

    const statuses: number[] = [];
    let last: APIResponse | null = null;
    for (let i = 0; i < 6; i += 1) {
      last = await request.post('/auth/login', {
        data: { email: customer.email, password: 'Wrong-password-1!' },
      });
      statuses.push(last.status());
    }

    expect(
      statuses.slice(0, 5).every((s) => s === 401),
      `got ${statuses.join(', ')}`,
    ).toBe(true);
    expect(statuses[5], await (last as APIResponse).text()).toBe(429);
    // The filter has no mapping for 429 (see registration.spec.ts) — either
    // code is a defensible answer to "slow down"; a 5xx status would not be.
    expect(['RATE_LIMIT_EXCEEDED', 'INTERNAL_ERROR']).toContain(
      (await apiError(last as APIResponse)).code,
    );

    // The throttle is the per-IP Redis counter and nothing else: no lockout
    // was written to the account. Clearing the counter (what the minute
    // expiring would do — a test cannot wait it out) must let the real
    // password straight in.
    await flushRedis();
    const genuine = await request.post('/auth/login', {
      data: { email: customer.email, password: customer.password },
    });
    expect(
      genuine.ok(),
      `five wrong guesses locked the account itself: ${await genuine.text()}`,
    ).toBeTruthy();
    expect(refreshCookie(genuine.headers())).not.toBeNull();
  });
});
