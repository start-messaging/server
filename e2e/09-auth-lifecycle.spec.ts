import { test, expect, APIRequestContext } from '@playwright/test';
import { resetDb, closeDb, sql } from './helpers/db.js';
import {
  createCustomer,
  onboardCustomer,
  auth,
  payload,
  unique,
  Customer,
} from './helpers/actors.js';

/**
 * Customer auth: register, login, refresh rotation, logout.
 *
 * The refresh cookie is `${userId}:${token}` and is parsed before the token is
 * verified, so the parsing itself is part of the attack surface.
 */
test.describe('auth lifecycle', () => {
  test.beforeEach(async () => {
    await resetDb();
  });

  test.afterAll(async () => {
    await closeDb();
  });

  /** Pulls the refresh_token cookie out of a Set-Cookie header. */
  function refreshCookie(headers: Record<string, string>): string | null {
    const raw = headers['set-cookie'] ?? '';
    const match = /refresh_token=([^;]+)/.exec(raw);
    return match ? match[1] : null;
  }

  async function register(request: APIRequestContext, email?: string) {
    const address = email ?? `${unique('auth')}@example.com`;
    const res = await request.post('/auth/register', {
      data: {
        email: address,
        password: 'Password123!',
        firstName: 'Test',
        lastName: 'User',
      },
    });
    return { res, email: address };
  }

  test('registration returns a token and creates the user', async ({
    request,
  }) => {
    const { res, email } = await register(request);
    expect(res.ok(), await res.text()).toBeTruthy();

    const body = await payload<{ accessToken: string; user: { id: string } }>(
      res,
    );
    expect(body.accessToken).toBeTruthy();

    const [row] = await sql<{ email: string; role: string }>(
      `SELECT "email", "role" FROM "users" WHERE "id" = $1`,
      [body.user.id],
    );
    expect(row.email).toBe(email.toLowerCase());
    expect(row.role).toBe('customer');
  });

  test('the password is never stored or returned in clear text', async ({
    request,
  }) => {
    const { res } = await register(request);
    const body = await payload<{ user: Record<string, unknown> }>(res);

    expect(JSON.stringify(body)).not.toContain('Password123!');
    expect(body.user).not.toHaveProperty('password');
    expect(body.user).not.toHaveProperty('passwordHash');

    const [row] = await sql<{ passwordHash: string | null }>(
      `SELECT "passwordHash" FROM "users" WHERE LOWER("email") = LOWER($1)`,
      [(body.user as { email: string }).email],
    );
    expect(row.passwordHash).toBeTruthy();
    expect(row.passwordHash).not.toBe('Password123!');
    // bcrypt, not a raw or reversible digest.
    expect(row.passwordHash).toMatch(/^\$2[aby]\$/);
  });

  test('a duplicate email is refused', async ({ request }) => {
    const { email } = await register(request);
    const second = await register(request, email);
    expect(second.res.ok()).toBeFalsy();
    expect([400, 409]).toContain(second.res.status());
  });

  test('registration rejects a weak password and a malformed email', async ({
    request,
  }) => {
    const weak = await request.post('/auth/register', {
      data: {
        email: `${unique('weak')}@example.com`,
        password: '123',
        firstName: 'A',
        lastName: 'B',
      },
    });
    expect(weak.status()).toBe(400);

    const malformed = await request.post('/auth/register', {
      data: {
        email: 'not-an-email',
        password: 'Password123!',
        firstName: 'A',
        lastName: 'B',
      },
    });
    expect(malformed.status()).toBe(400);
  });

  test('a caller cannot register themselves as an admin', async ({
    request,
  }) => {
    const email = `${unique('escalate')}@example.com`;
    const res = await request.post('/auth/register', {
      data: {
        email,
        password: 'Password123!',
        firstName: 'A',
        lastName: 'B',
        role: 'admin',
      },
    });

    // Either the DTO refuses the field outright, or it is ignored — but the
    // stored role must never be admin.
    if (res.ok()) {
      const [row] = await sql<{ role: string }>(
        `SELECT "role" FROM "users" WHERE "email" = $1`,
        [email.toLowerCase()],
      );
      expect(row.role).toBe('customer');
    } else {
      expect(res.status()).toBe(400);
    }
  });

  test('login with a wrong password fails and reveals nothing extra', async ({
    request,
  }) => {
    const customer = await createCustomer(request);

    const wrong = await request.post('/auth/login', {
      data: { email: customer.email, password: 'WrongPassword123!' },
    });
    const unknown = await request.post('/auth/login', {
      data: { email: `${unique('ghost')}@example.com`, password: 'Password123!' },
    });

    // Compared on the error itself: requestId and timestamp differ by design.
    expect(wrong.status()).toBe(401);
    expect(unknown.status()).toBe(401);
    const a = (await wrong.json()) as { error: unknown };
    const b = (await unknown.json()) as { error: unknown };
    expect(a.error).toEqual(b.error);
  });

  test('login is case-insensitive on the email', async ({ request }) => {
    const customer = await createCustomer(request);
    const res = await request.post('/auth/login', {
      data: { email: customer.email.toUpperCase(), password: customer.password },
    });
    expect(res.ok(), await res.text()).toBeTruthy();
  });

  test('capitalisation cannot create a second account for one person', async ({
    request,
  }) => {
    // Email is case-insensitive to every mainstream provider, so these are one
    // person. Two rows would mean two wallets and two balances.
    const mixed = `Case${unique('Dup')}@Example.com`;
    const first = await request.post('/auth/register', {
      data: { email: mixed, password: 'Password123!', firstName: 'A', lastName: 'B' },
    });
    expect(first.ok(), await first.text()).toBeTruthy();

    const second = await request.post('/auth/register', {
      data: {
        email: mixed.toLowerCase(),
        password: 'Password123!',
        firstName: 'A',
        lastName: 'B',
      },
    });
    expect(second.ok(), 'a second account was created for the same email').toBeFalsy();

    const [{ count }] = await sql<{ count: string }>(
      `SELECT COUNT(*)::int AS count FROM "users" WHERE LOWER("email") = LOWER($1)`,
      [mixed],
    );
    expect(Number(count)).toBe(1);
  });

  test('an account registered in mixed case can log in in any case', async ({
    request,
  }) => {
    const mixed = `Case${unique('Login')}@Example.com`;
    await request.post('/auth/register', {
      data: { email: mixed, password: 'Password123!', firstName: 'A', lastName: 'B' },
    });

    for (const spelling of [mixed, mixed.toLowerCase(), mixed.toUpperCase()]) {
      const res = await request.post('/auth/login', {
        data: { email: spelling, password: 'Password123!' },
      });
      expect(res.ok(), `login failed for "${spelling}"`).toBeTruthy();
    }
  });

  test('refresh rotates the token and the old one stops working', async ({
    request,
  }) => {
    const email = `${unique('rotate')}@example.com`;
    const login = await request.post('/auth/register', {
      data: { email, password: 'Password123!', firstName: 'A', lastName: 'B' },
    });
    const first = refreshCookie(login.headers());
    expect(first).toBeTruthy();

    const refreshed = await request.post('/auth/refresh', {
      headers: { Cookie: `refresh_token=${first}` },
    });
    expect(refreshed.ok(), await refreshed.text()).toBeTruthy();

    const second = refreshCookie(refreshed.headers());
    expect(second).toBeTruthy();
    expect(second).not.toBe(first);

    // Replaying the consumed cookie must fail: that is what makes theft of an
    // old token useless.
    const replay = await request.post('/auth/refresh', {
      headers: { Cookie: `refresh_token=${first}` },
    });
    expect(replay.ok(), 'a rotated refresh token was accepted again').toBeFalsy();
  });

  test('refresh without a cookie is rejected', async ({ request }) => {
    const res = await request.post('/auth/refresh');
    expect(res.status()).toBe(401);
  });

  test('a tampered refresh cookie is rejected without a 500', async ({
    request,
  }) => {
    const cases = [
      'garbage',
      'not-a-uuid:token',
      `${'0'.repeat(8)}-0000-4000-8000-000000000000:wrongtoken`,
      ':',
      'j%3A1',
      `${'a'.repeat(500)}:${'b'.repeat(500)}`,
    ];

    for (const value of cases) {
      const res = await request.post('/auth/refresh', {
        headers: { Cookie: `refresh_token=${value}` },
      });
      expect(res.status(), `refresh_token=${value} returned a server error`).toBe(
        401,
      );
    }
  });

  test('one user cannot refresh using another user id', async ({ request }) => {
    const a = await request.post('/auth/register', {
      data: {
        email: `${unique('vic')}@example.com`,
        password: 'Password123!',
        firstName: 'A',
        lastName: 'B',
      },
    });
    const victimCookie = refreshCookie(a.headers()) as string;
    const victimToken = victimCookie.split('%3A').pop() ?? victimCookie.split(':').pop();

    const attacker = await createCustomer(request);

    // Same token, someone else's id in the front half of the cookie.
    const res = await request.post('/auth/refresh', {
      headers: { Cookie: `refresh_token=${attacker.id}:${victimToken}` },
    });
    expect(res.ok(), 'a refresh token was accepted for a different user').toBeFalsy();
  });

  test('logout revokes the refresh token', async ({ request }) => {
    const email = `${unique('logout')}@example.com`;
    const reg = await request.post('/auth/register', {
      data: { email, password: 'Password123!', firstName: 'A', lastName: 'B' },
    });
    const body = await payload<{ accessToken: string; user: { id: string } }>(
      reg,
    );
    const cookie = refreshCookie(reg.headers());

    const out = await request.post('/auth/logout', {
      headers: auth(body.accessToken),
    });
    expect(out.ok(), await out.text()).toBeTruthy();

    const replay = await request.post('/auth/refresh', {
      headers: { Cookie: `refresh_token=${cookie}` },
    });
    expect(replay.ok(), 'refresh worked after logout').toBeFalsy();
  });

  test('logout requires authentication', async ({ request }) => {
    const res = await request.post('/auth/logout');
    expect([401, 403]).toContain(res.status());
  });

  test('an expired-looking or forged access token is rejected', async ({
    request,
  }) => {
    const forged =
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.' +
      'eyJzdWIiOiIwMDAwMDAwMC0wMDAwLTQwMDAtODAwMC0wMDAwMDAwMDAwMDAiLCJlbWFpbCI6ImFAYi5jb20ifQ.' +
      'ZmFrZXNpZ25hdHVyZQ';

    for (const token of [forged, 'not.a.jwt', '', 'Bearer']) {
      const res = await request.get('/users/me', {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect([401, 403], `token "${token.slice(0, 20)}" was accepted`).toContain(
        res.status(),
      );
    }
  });

  test('google auth rejects a bogus id token without creating a user', async ({
    request,
  }) => {
    const before = await sql<{ count: string }>(
      `SELECT COUNT(*)::int AS count FROM "users"`,
    );

    const res = await request.post('/auth/google', {
      data: { idToken: 'clearly-not-a-google-token' },
    });
    expect(res.ok()).toBeFalsy();
    expect(res.status()).toBeLessThan(500);

    const after = await sql<{ count: string }>(
      `SELECT COUNT(*)::int AS count FROM "users"`,
    );
    expect(Number(after[0].count)).toBe(Number(before[0].count));
  });

  test('/users/me returns the caller and nothing sensitive', async ({
    request,
  }) => {
    const customer = await createCustomer(request);
    await onboardCustomer(customer.id);

    const res = await request.get('/users/me', {
      headers: auth(customer.accessToken),
    });
    expect(res.ok(), await res.text()).toBeTruthy();

    const body = await payload<Record<string, unknown>>(res);
    expect(body.id).toBe(customer.id);
    expect(body).not.toHaveProperty('password');
    expect(body).not.toHaveProperty('passwordHash');
    expect(body).not.toHaveProperty('refreshTokenHash');
  });
});
