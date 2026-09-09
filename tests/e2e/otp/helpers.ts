import { APIRequestContext, APIResponse } from '@playwright/test';
import * as bcrypt from 'bcrypt';
import { sql } from '../helpers/db.js';
import { auth } from '../helpers/actors.js';
import { seedLedger } from '../helpers/wallet.js';

/**
 * Shared fixtures for the `POST /otp/send` specs in this directory.
 *
 * The seams of `POST /otp/send`: who may call it, what the DTO lets through,
 * the per-number ceiling the OTP service keeps in Redis, what a successful
 * send writes, and which template it renders — one spec file each, every one
 * of them built on the constants and helpers below.
 *
 * wallet/otp-billing covers the money path and the obvious rejections; these
 * files go after what that one takes for granted.
 * tests/e2e/otp/mobile-verification.spec.ts covers the three questions about
 * mobile-verification codes that users/mobile-verification cannot reach
 * through the API — see the docstring there.
 */

/** OTP_COST in .env.e2e. The pre-send balance check compares against exactly this. */
export const OTP_COST = 0.25;

/** `checkMobileRateLimit` refuses the fourth INCR on one number inside 5 minutes. */
export const SENDS_PER_NUMBER = 3;

/**
 * The body the service falls back to when no template resolves, rendered with
 * the default `expiry` and with the code masked on the way into storage.
 *
 * This is what the customer sees, and every test in this directory that
 * reaches the fallback asserts exactly it: a key the caller omitted may not
 * beat its computed default, so the word "undefined" can never appear in an
 * OTP.
 */
export const FALLBACK_RENDERED =
  'Your verification code is ******. Valid for 5 minutes.';

export interface SendResult {
  otpRequestId: string;
  messageId: string;
  status: string;
  phoneNumber: string;
  createdAt: string;
}

/**
 * A distinct, DTO-valid Indian mobile per call.
 *
 * The rate-limit key is `limit:mobile:<phoneNumber>`, so two tests sharing a
 * number would share a counter. resetDb flushes Redis between tests, but a
 * number that is unique per call means a test can never be poisoned by an
 * earlier one even if that flush is ever weakened.
 */
let phoneCounter = 0;
export function phone(): string {
  phoneCounter += 1;
  const digits = `${process.pid}${phoneCounter}`.slice(-9).padStart(9, '0');
  return `+919${digits}`;
}

export function sendOtp(
  request: APIRequestContext,
  token: string,
  body: Record<string, unknown>,
) {
  return request.post('/otp/send', { data: body, headers: auth(token) });
}

/** The OTP itself lives in a nested `variables` object, not at the top level. */
export function otpBody(
  phoneNumber: string,
  otp: unknown = '123456',
  extra: Record<string, unknown> = {},
) {
  return { phoneNumber, variables: { otp }, ...extra };
}

/**
 * Errors here are `{ code, message }` inside the global envelope's `error`.
 * Asserting on `code` rather than prose is what keeps these tests from
 * breaking when somebody rewords a message.
 */
export async function errorOf(
  res: APIResponse,
): Promise<{ code: string; message: string }> {
  const text = await res.text();
  const body = JSON.parse(text) as {
    error?: { code: string; message: string };
  };
  if (!body.error) {
    throw new Error(`expected an error envelope, got: ${text.slice(0, 300)}`);
  }
  return body.error;
}

export async function messagesFor(userId: string) {
  return sql<{
    id: string;
    status: string;
    costAmount: string;
    apiKeyId: string | null;
    otpRequestId: string | null;
    otpTemplateId: string | null;
    renderedContent: string | null;
    metadata: { intendedCost?: number } | null;
  }>(
    `SELECT "id", "status", "costAmount", "apiKeyId", "otpRequestId",
            "otpTemplateId", "renderedContent", "metadata"
       FROM "messages" WHERE "userId" = $1 ORDER BY "createdAt"`,
    [userId],
  );
}

export async function otpRequestsFor(userId: string) {
  return sql<{
    id: string;
    status: string;
    code: string | null;
    phoneNumber: string;
    createdAt: Date;
    expiresAt: Date | null;
  }>(
    `SELECT "id", "status", "code", "phoneNumber", "createdAt", "expiresAt"
       FROM "otp_requests" WHERE "userId" = $1 ORDER BY "createdAt"`,
    [userId],
  );
}

export async function balanceOf(userId: string): Promise<number> {
  const [row] = await sql<{ balance: string }>(
    `SELECT "balance" FROM "wallets" WHERE "userId" = $1`,
    [userId],
  );
  return Number(row?.balance ?? 0);
}

/**
 * Moves a wallet to an exact balance and files the matching ledger entry.
 *
 * Setting the column alone would leave the wallet disagreeing with its own
 * transaction history, which is the invariant tests/e2e/wallet/otp-billing.spec.ts
 * asserts — a fixture that breaks it would make an unrelated test fail for the
 * wrong reason.
 *
 * The hand-rolled version read `wallet.balance` off a row it never checked for,
 * so it threw a TypeError rather than seeding anything for a user made by
 * actors.ts seedCustomer. seedLedger creates the wallet the way lockWallet does.
 */
export async function setBalance(userId: string, amount: number) {
  await seedLedger(userId, {
    to: amount,
    description: 'e2e fixture balance',
  });
}

/**
 * bcrypt.compare is what the service runs, so `otpHash` has to be a real
 * bcrypt digest. Four rounds: the cost only decides how long the fixture
 * takes to build, never what is asserted.
 *
 * `mobile_otps` has no foreign key to `users`, so resetDb's
 * `TRUNCATE ... CASCADE` never reaches it and these rows outlive the test
 * that wrote them. Every read below is scoped by `userId` and users *are*
 * truncated, so nothing leaks — but the table does grow across runs.
 */
export async function seedMobileOtp(
  userId: string,
  opts: { code?: string; createdAt?: Date } = {},
): Promise<string> {
  // attempts, maxAttempts and verified are left to the column defaults
  // (0, 3, false) — the shape a freshly issued code has.
  const [row] = await sql<{ id: string }>(
    `INSERT INTO "mobile_otps"
       ("userId", "phoneNumber", "otpHash", "expiresAt", "createdAt", "updatedAt")
     VALUES ($1, $2, $3, $4, $5, $5)
     RETURNING "id"`,
    [
      userId,
      phone(),
      await bcrypt.hash(opts.code ?? '123456', 4),
      new Date(Date.now() + 5 * 60_000),
      opts.createdAt ?? new Date(),
    ],
  );
  return row.id;
}

export async function otpRow(id: string) {
  const [row] = await sql<{ attempts: number; verified: boolean }>(
    `SELECT "attempts", "verified" FROM "mobile_otps" WHERE "id" = $1`,
    [id],
  );
  return row;
}

export async function mobileVerified(userId: string): Promise<boolean> {
  const [row] = await sql<{ mobileVerified: boolean }>(
    `SELECT "mobileVerified" FROM "users" WHERE "id" = $1`,
    [userId],
  );
  return row.mobileVerified;
}

export function verify(
  request: APIRequestContext,
  token: string,
  otp: unknown,
) {
  return request.post('/users/verify-mobile-otp', {
    data: { otp },
    headers: auth(token),
  });
}
