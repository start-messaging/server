import { expect, APIRequestContext, APIResponse } from '@playwright/test';
import { createHmac } from 'crypto';
import { payload, unique } from '../helpers/actors.js';

/**
 * Shared fixtures for the `src/auth` edge-case specs: the five routes on
 * AuthController, the DTOs the global ValidationPipe runs over them, and the
 * JWT strategy every other module trusts.
 *
 * auth/lifecycle covers the happy path and the rotation of the refresh
 * cookie; the specs that import this module go after what is left — token
 * forgery, role confusion, the conversions `enableImplicitConversion`
 * performs before a validator ever sees the value, and the money a refused
 * registration must not create.
 *
 * Budget note: `/auth/register` and `/auth/login` are throttled to 5 per
 * minute per IP and `/auth/refresh` to 10 (auth.controller.ts). `resetDb()`
 * flushes the Redis counters, so the budget is per test — every test in these
 * specs stays inside it except the one that deliberately proves the limit
 * (tests/e2e/auth/registration.spec.ts).
 */

export const JWT_SECRET = process.env.JWT_SECRET ?? '';

/** Pulls the refresh_token cookie out of a Set-Cookie header. */
export function refreshCookie(headers: Record<string, string>): string | null {
  const raw = headers['set-cookie'] ?? '';
  const match = /refresh_token=([^;]+)/.exec(raw);
  return match ? match[1] : null;
}

/**
 * Splits the cookie into its two halves.
 *
 * Express percent-encodes the value, so the `:` the server wrote arrives as
 * `%3A` and has to be decoded before the token half can be hashed and
 * compared with the stored column.
 */
export function splitRefreshCookie(rawCookieValue: string): {
  userId: string;
  token: string;
} {
  const decoded = decodeURIComponent(rawCookieValue);
  const index = decoded.indexOf(':');
  return {
    userId: decoded.slice(0, index),
    token: decoded.slice(index + 1),
  };
}

/** `{ code, message }` off an error response, whatever the status. */
export async function apiError(
  res: APIResponse,
): Promise<{ code?: string; message?: string }> {
  const body = (await res.json()) as {
    error?: { code?: string; message?: string };
  };
  return body.error ?? {};
}

export const base64url = (input: Buffer | string): string =>
  (typeof input === 'string' ? Buffer.from(input, 'utf8') : input)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

/**
 * Mints a JWT by hand.
 *
 * The suite loads the same `.env.e2e` the server runs with, so a token signed
 * here with `JWT_SECRET` is indistinguishable from one the API issued. That is
 * the only way to test claims the API will never mint — an `exp` in the past
 * above all, since the real expiry is fifteen minutes away.
 */
export function mintToken(
  claims: Record<string, unknown>,
  secret: string,
  alg: 'HS256' | 'none' = 'HS256',
): string {
  const header = base64url(JSON.stringify({ alg, typ: 'JWT' }));
  const body = base64url(JSON.stringify(claims));
  if (alg === 'none') return `${header}.${body}.`;
  const signature = base64url(
    createHmac('sha256', secret).update(`${header}.${body}`).digest(),
  );
  return `${header}.${body}.${signature}`;
}

/** Rewrites the claims of a real token, keeping its original signature. */
export function editClaims(
  token: string,
  patch: Record<string, unknown>,
): string {
  const [header, body, signature] = token.split('.');
  const claims = JSON.parse(
    Buffer.from(body, 'base64url').toString('utf8'),
  ) as Record<string, unknown>;
  return `${header}.${base64url(JSON.stringify({ ...claims, ...patch }))}.${signature}`;
}

export function register(
  request: APIRequestContext,
  data: Record<string, unknown>,
) {
  return request.post('/auth/register', { data });
}

/**
 * Registers and returns the parts of the session a refresh test needs.
 *
 * Every request in tests/e2e/auth/sessions.spec.ts passes its cookie
 * explicitly: Playwright's request context keeps a cookie jar, and the refresh
 * cookie is scoped to /auth, so a call made without a Cookie header would
 * quietly carry the real one and pass for the wrong reason.
 */
export async function session(request: APIRequestContext) {
  const email = `${unique('sess')}@example.com`;
  const res = await register(request, {
    email,
    password: 'Password123!',
    firstName: 'A',
    lastName: 'B',
  });
  expect(res.ok(), await res.text()).toBeTruthy();

  const raw = refreshCookie(res.headers()) as string;
  const body = await payload<{ accessToken: string; user: { id: string } }>(
    res,
  );
  return {
    email,
    raw,
    ...splitRefreshCookie(raw),
    accessToken: body.accessToken,
    id: body.user.id,
  };
}

export const withCookie = (value: string) => ({
  Cookie: `refresh_token=${value}`,
});
