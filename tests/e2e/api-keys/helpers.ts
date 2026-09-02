import { expect, APIRequestContext, APIResponse } from '@playwright/test';
import { createHash, createHmac } from 'crypto';
import { sql } from '../helpers/db.js';
import { auth, payload } from '../helpers/actors.js';
import { seedLedger } from '../helpers/wallet.js';

/**
 * API keys, at the seams — shared fixtures.
 *
 * api-keys/lifecycle.spec.ts covers the shape of the feature: the plaintext comes
 * back once, a revoked key stops working, one customer cannot touch another's.
 * The edge-case specs alongside this module are about the edges of that surface —
 * the ones where an API key is not a "key" at all but a full account credential.
 * Everything here is the scaffolding they share: the row shapes, the hand-rolled
 * token minter, the error unwrapper, and the create/read shortcuts.
 *
 * Where the behaviour those specs pin looks wrong it is pinned, not corrected: a
 * failing assertion there would say "the product changed", which is the only
 * useful thing a test can say about a defect it cannot fix.
 */

export interface CreatedKey {
  id: string;
  key: string;
  keyPrefix: string;
  label: string;
  allowedIps: string[] | null;
  createdAt: string;
}

export interface KeyRow {
  id: string;
  userId: string;
  keyPrefix: string;
  keyHash: string;
  label: string;
  isActive: boolean;
  allowedIps: string[] | null;
  lastUsedAt: Date | null;
  deletedAt: Date | null;
}

/** A well-formed uuid that no row will ever have. */
export const ABSENT_UUID = '00000000-0000-4000-8000-00000000dead';

export const sha256 = (value: string) =>
  createHash('sha256').update(value).digest('hex');

export function b64url(input: string | Buffer): string {
  return Buffer.from(input)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/**
 * Mints an access token by hand.
 *
 * The suite has the same JWT_SECRET the server does (playwright.config.ts
 * loads .env.e2e), so tokens can be built with claims no endpoint would ever
 * issue — expired, wrongly signed, unsigned, or naming a subject that does not
 * exist. Nothing else can reach those branches of JwtStrategy.
 */
export function mintToken(
  claims: Record<string, unknown>,
  opts: { secret?: string; alg?: string; signature?: string } = {},
): string {
  const header = b64url(
    JSON.stringify({ alg: opts.alg ?? 'HS256', typ: 'JWT' }),
  );
  const body = b64url(JSON.stringify(claims));
  const signature =
    opts.signature ??
    b64url(
      createHmac('sha256', opts.secret ?? process.env.JWT_SECRET ?? '')
        .update(`${header}.${body}`)
        .digest(),
    );
  return `${header}.${body}.${signature}`;
}

/** Unwraps the `{ code, message }` half of the error envelope. */
export async function errorOf(
  res: APIResponse,
): Promise<{ code: string; message: string }> {
  const body = (await res.json()) as {
    error?: { code: string; message: string };
  };
  if (!body.error) {
    throw new Error(
      `expected an error envelope, got ${JSON.stringify(body).slice(0, 300)}`,
    );
  }
  return body.error;
}

export async function createKey(
  request: APIRequestContext,
  token: string,
  body: Record<string, unknown> = {},
): Promise<CreatedKey> {
  const res = await request.post('/api-keys', {
    data: { label: 'edge', ...body },
    headers: auth(token),
  });
  expect(res.status(), await res.text()).toBe(201);
  return payload<CreatedKey>(res);
}

export async function keyRows(userId: string): Promise<KeyRow[]> {
  return sql<KeyRow>(
    `SELECT * FROM "api_keys" WHERE "userId" = $1 ORDER BY "createdAt" ASC`,
    [userId],
  );
}

/**
 * Puts a customer's wallet on `balance` — enough that an OTP send in these
 * specs never fails for want of money, which is never what they are about.
 *
 * The default stays 500 so the three bare `seedWallet(customer.id)` calls in
 * credential.spec.ts keep meaning what they meant; it is a figure chosen to be
 * plenty, not a real one, and tags.service.ts:166 derives `health:low-balance`
 * from `wallets.balance` at < 50, so a tariff change can move what state this
 * describes without moving what it asserts.
 */
export async function seedWallet(userId: string, balance = 500): Promise<void> {
  await seedLedger(userId, {
    to: balance,
    description: 'e2e fixture adjustment',
  });
}
