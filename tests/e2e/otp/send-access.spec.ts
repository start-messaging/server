import { test, expect } from '@playwright/test';
import { resetDb, closeDb, sql } from '../helpers/db.js';
import {
  createAdmin,
  createCustomer,
  onboardCustomer,
  auth,
  payload,
  Customer,
} from '../helpers/actors.js';
import {
  balanceOf,
  errorOf,
  messagesFor,
  otpBody,
  otpRequestsFor,
  phone,
  sendOtp,
  setBalance,
} from './helpers.js';

/**
 * One seam of `POST /otp/send`: who may call it.
 *
 * wallet/otp-billing covers the money path and the obvious rejections; this
 * file goes after what that one takes for granted.
 */

test.describe('OTP send: who may call it', () => {
  let customer: Customer;

  test.beforeEach(async ({ request }) => {
    await resetDb();
    customer = await createCustomer(request);
    await onboardCustomer(customer.id);
  });

  test.afterAll(async () => {
    await closeDb();
  });

  test('an unauthenticated send is refused before anything is written', async ({
    request,
  }) => {
    const res = await request.post('/otp/send', { data: otpBody(phone()) });

    expect(res.status(), await res.text()).toBe(401);
    expect((await errorOf(res)).code).toBe('UNAUTHORIZED');

    // The row is created before the provider is called, so "nothing written"
    // is the only proof that the guard ran ahead of the service.
    const [{ count }] = await sql<{ count: string }>(
      `SELECT COUNT(*)::int AS count FROM "otp_requests"`,
    );
    expect(Number(count)).toBe(0);
  });

  test('a token whose signature or claims were edited is refused', async ({
    request,
  }) => {
    const other = await createCustomer(request);
    const [header, claims, signature] = customer.accessToken.split('.');
    const otherClaims = other.accessToken.split('.')[1];

    // An unsigned "alg: none" token carrying this customer's own subject and an
    // escalated role. If the strategy ever honoured the header's algorithm this
    // would be a free admin session, so it is worth an explicit case.
    const noneAlg =
      `${Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url')}.` +
      `${Buffer.from(
        JSON.stringify({
          sub: customer.id,
          email: customer.email,
          role: 'admin',
        }),
      ).toString('base64url')}.`;

    const forged = [
      // Same claims, one character of the signature flipped.
      `${header}.${claims}.${signature.slice(0, -1)}${signature.slice(-1) === 'a' ? 'b' : 'a'}`,
      // Another customer's claims wearing this customer's signature.
      `${header}.${otherClaims}.${signature}`,
      // Signature removed entirely.
      `${header}.${claims}`,
      // Padding appended after a valid token.
      `${customer.accessToken}x`,
      noneAlg,
    ];

    for (const token of forged) {
      const res = await sendOtp(request, token, otpBody(phone()));
      expect(
        res.status(),
        `a tampered token was accepted: ${token.slice(0, 24)}…`,
      ).toBe(401);
      expect((await errorOf(res)).code).toBe('UNAUTHORIZED');
    }

    const [{ count }] = await sql<{ count: string }>(
      `SELECT COUNT(*)::int AS count FROM "otp_requests"`,
    );
    expect(Number(count)).toBe(0);
  });

  test('a customer who has not finished onboarding cannot send', async ({
    request,
  }) => {
    const fresh = await createCustomer(request);

    const res = await sendOtp(request, fresh.accessToken, otpBody(phone()));
    expect(res.status(), await res.text()).toBe(403);

    // OnboardingGuard raises `{ errorCode: ONBOARDING_INCOMPLETE, ... }`, but
    // the exception filter reads `code`, so what reaches the client is the
    // generic FORBIDDEN and the step number is the only clue about why. Pinned
    // as it behaves today; the mismatch is reported, not papered over.
    expect((await errorOf(res)).code).toBe('FORBIDDEN');

    expect((await otpRequestsFor(fresh.id)).length).toBe(0);
    // The registration welcome credit is untouched: a refusal must not cost.
    expect(await balanceOf(fresh.id)).toBe(10);
  });

  test('a deactivated account cannot spend the token it already holds', async ({
    request,
  }) => {
    // users/kyc-onboarding already pins the 403 itself. What is only asserted
    // here is the money side of it: deactivation has to bite on the next
    // request, not when the 15-minute access token happens to expire, so an
    // account switched off for fraud writes no message row and spends nothing.
    await sql(`UPDATE "users" SET "isActive" = false WHERE "id" = $1`, [
      customer.id,
    ]);

    const res = await sendOtp(request, customer.accessToken, otpBody(phone()));
    expect(res.status(), await res.text()).toBe(403);
    expect((await errorOf(res)).code).toBe('FORBIDDEN');

    expect((await messagesFor(customer.id)).length).toBe(0);
    expect(await balanceOf(customer.id)).toBe(10);
  });

  test('a still-valid token for a purged account faults with a 500', async ({
    request,
  }) => {
    // KNOWN DEFECT, pinned as it behaves today.
    //
    // JwtStrategy.validate verifies the signature and never looks the user up,
    // and OnboardingGuard treats a missing row as nothing to check
    // (`if (!user) return true`). So the request reaches the service, and
    // WalletService.getWallet inserts a wallet for a userId with no user —
    // which FK_wallets_userId refuses. A QueryFailedError is not an
    // HttpException, so AllExceptionsFilter answers 500/INTERNAL_ERROR.
    //
    // A purge or hard delete while a session is live is the realistic way in,
    // and the right answer is 401. Asserting 4xx here would make this test red
    // on a defect the suite is supposed to describe, so it pins the 500 and
    // the fix is expected to flip it.
    const ghost = await createCustomer(request);
    await sql(
      `DELETE FROM "wallet_transactions"
        WHERE "walletId" IN (SELECT "id" FROM "wallets" WHERE "userId" = $1)`,
      [ghost.id],
    );
    await sql(`DELETE FROM "wallets" WHERE "userId" = $1`, [ghost.id]);
    await sql(`DELETE FROM "users" WHERE "id" = $1`, [ghost.id]);

    const res = await sendOtp(request, ghost.accessToken, otpBody(phone()));
    expect(res.status(), await res.text()).toBe(500);
    expect((await errorOf(res)).code).toBe('INTERNAL_ERROR');

    const [{ count }] = await sql<{ count: string }>(
      `SELECT COUNT(*)::int AS count FROM "wallets" WHERE "userId" = $1`,
      [ghost.id],
    );
    expect(
      Number(count),
      'a wallet was created for a user that does not exist',
    ).toBe(0);
  });

  test('an admin sending an OTP is billed like anyone else', async ({
    request,
  }) => {
    // Admins skip the onboarding gate, which is deliberate. Skipping the
    // balance check would not be: it is the same wallet machinery, and an
    // unbilled sender is a free SMS gateway.
    const admin = await createAdmin(request);
    await setBalance(admin.id, 0);

    const res = await sendOtp(request, admin.accessToken, otpBody(phone()));
    expect(res.status(), await res.text()).toBe(400);
    expect((await errorOf(res)).code).toBe('INSUFFICIENT_BALANCE');

    expect((await messagesFor(admin.id)).length).toBe(0);
  });

  test('a bearer token wins over an API key sent beside it, and only its owner is billed', async ({
    request,
  }) => {
    // The combined guard tries the JWT first and never looks at the API key
    // once it succeeds. A client that sends both — a stale key header plus a
    // fresh session — must therefore be charged to the session's owner, and
    // the key's owner must be left entirely out of it.
    const keyOwner = await createCustomer(request);
    await onboardCustomer(keyOwner.id);
    const created = await request.post('/api-keys', {
      data: { label: 'e2e-otp' },
      headers: auth(keyOwner.accessToken),
    });
    expect(created.ok(), await created.text()).toBeTruthy();
    const key = await payload<{ id: string; key?: string; apiKey?: string }>(
      created,
    );
    const plaintext = (key.key ?? key.apiKey) as string;

    const res = await request.post('/otp/send', {
      data: otpBody(phone()),
      headers: { ...auth(customer.accessToken), 'x-api-key': plaintext },
    });
    expect(res.status(), await res.text()).toBe(201);

    const mine = await messagesFor(customer.id);
    expect(mine.length).toBe(1);
    // Attribution follows the credential that actually authenticated: no key.
    expect(mine[0].apiKeyId).toBeNull();
    expect((await messagesFor(keyOwner.id)).length).toBe(0);
  });
});
