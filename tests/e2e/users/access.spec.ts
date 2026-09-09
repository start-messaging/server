import { test, expect, APIResponse } from '@playwright/test';
import { resetDb, closeDb, sql } from '../helpers/db.js';
import {
  auth,
  createAdmin,
  createCustomer,
  createPartner,
  onboardCustomer,
  payload,
  Customer,
} from '../helpers/actors.js';
import { errorCode, phone, userRow } from './helpers.js';

/**
 * The seven routes under /users — the surface every signed-in account owns.
 *
 * None of them takes an id: the caller is whoever the token says they are, so
 * "one user touching another user's resource" can only be attempted by
 * steering a self-scoped route with a body field, a query parameter or a
 * second credential. Those attempts are what this file covers; the body-field
 * half of them continues in tests/e2e/users/profile.spec.ts.
 *
 * Errors are `{ code, message }`. The split worth knowing when reading the
 * assertions below: a DTO rejection comes back as VALIDATION_ERROR (the
 * exception filter recognises class-validator's message array), while a rule
 * enforced inside UsersService is a plain BadRequestException and lands as
 * INVALID_INPUT.
 */

test.describe('users routes: who is allowed to call them', () => {
  let customer: Customer;

  test.beforeEach(async ({ request }) => {
    await resetDb();
    customer = await createCustomer(request);
  });

  test.afterAll(async () => {
    await closeDb();
  });

  test('every users route refuses a call with no credential at all', async ({
    request,
  }) => {
    const calls: Array<[string, Promise<APIResponse>]> = [
      ['GET /users/me', request.get('/users/me')],
      ['PATCH /users/me', request.patch('/users/me', { data: {} })],
      [
        'POST /users/send-mobile-otp',
        request.post('/users/send-mobile-otp', {
          data: { mobileNumber: phone(1) },
        }),
      ],
      [
        'POST /users/verify-mobile-otp',
        request.post('/users/verify-mobile-otp', { data: { otp: '123456' } }),
      ],
      ['GET /users/onboarding-status', request.get('/users/onboarding-status')],
      ['POST /users/kyc', request.post('/users/kyc', { data: {} })],
      ['GET /users/kyc', request.get('/users/kyc')],
    ];

    for (const [name, pending] of calls) {
      const res = await pending;
      expect(res.status(), `${name} was reachable anonymously`).toBe(401);
      expect(await errorCode(res)).toBe('UNAUTHORIZED');
    }
  });

  test('a partner session cannot cross into the customer users routes', async ({
    request,
  }) => {
    // Partner tokens are signed with PARTNER_JWT_SECRET. A partner is a real,
    // logged-in principal on this deployment — it just is not a user — so this
    // is the realistic "valid token, wrong realm" case.
    const partner = await createPartner(request);

    for (const res of [
      await request.get('/users/me', { headers: auth(partner.accessToken) }),
      await request.patch('/users/me', {
        data: { firstName: 'Crossover' },
        headers: auth(partner.accessToken),
      }),
      await request.get('/users/kyc', { headers: auth(partner.accessToken) }),
    ]) {
      expect(res.status(), await res.text()).toBe(401);
      expect(await errorCode(res)).toBe('UNAUTHORIZED');
    }
  });

  test('a token for an account that no longer exists resolves to nobody', async ({
    request,
  }) => {
    // What an erasure request leaves behind: the row is gone from every read
    // path, but the access token it was issued for is still valid for its
    // remaining lifetime. Nothing here may fall back to another account.
    const token = customer.accessToken;
    await sql(`UPDATE "users" SET "deletedAt" = now() WHERE "id" = $1`, [
      customer.id,
    ]);

    // `getMe` returns null for a row it cannot find and the response
    // interceptor wraps that as `data: null`, so this is a 200 with nothing in
    // it rather than a 404 — the first of the three answers this one state
    // gets.
    const me = await request.get('/users/me', { headers: auth(token) });
    expect(me.status(), await me.text()).toBe(200);
    expect(await payload(me), 'a deleted account was handed a profile').toBe(
      null,
    );

    // The same state answers 404 here — worth knowing the surface is not
    // consistent about it, and worth failing if either side starts leaking a
    // different account instead.
    const status = await request.get('/users/onboarding-status', {
      headers: auth(token),
    });
    expect(status.status()).toBe(404);
    expect(await errorCode(status)).toBe('NOT_FOUND');

    const kyc = await request.get('/users/kyc', { headers: auth(token) });
    expect(kyc.status()).toBe(404);

    // And an update for a row nobody can read must not report success.
    const patched = await request.patch('/users/me', {
      data: { firstName: 'Ghost' },
      headers: auth(token),
    });
    expect(
      patched.ok(),
      'a profile update succeeded for an account that cannot be read back',
    ).toBeFalsy();
  });

  test('a customer cannot steer /users/me at another account', async ({
    request,
  }) => {
    const victim = await createCustomer(request);

    // A query parameter is the cheapest thing to try, and costs nothing to
    // rule out: the handler takes its id from the token and nowhere else.
    const read = await request.get(`/users/me?userId=${victim.id}`, {
      headers: auth(customer.accessToken),
    });
    expect(read.status(), await read.text()).toBe(200);
    expect((await payload<{ id: string }>(read)).id).toBe(customer.id);

    // And an id in the body must not redirect the write.
    const written = await request.patch('/users/me', {
      data: { id: victim.id, userId: victim.id, firstName: 'Hijacked' },
      headers: auth(customer.accessToken),
    });
    expect(written.status(), await written.text()).toBe(200);

    expect((await userRow(customer.id)).firstName).toBe('Hijacked');
    const victimRow = await userRow(victim.id);
    expect(victimRow.firstName, "another account's name was rewritten").toBe(
      'Test',
    );
    expect(victimRow.email).toBe(victim.email.toLowerCase());
  });

  test('an admin calling /users/me gets their own row and no internal columns', async ({
    request,
  }) => {
    // /users has no @Roles, so an admin token is accepted here — it just must
    // not turn the route into a privileged view. The call-tracking columns are
    // `select: false` precisely because they are internal notes about an
    // account rather than the account holder's own data.
    const admin = await createAdmin(request);
    await sql(
      `UPDATE "users"
          SET "adminCallNotes" = 'Chased twice, no answer', "adminLastCalledAt" = now()
        WHERE "id" IN ($1, $2)`,
      [admin.id, customer.id],
    );

    for (const actor of [admin, customer]) {
      const res = await request.get('/users/me', {
        headers: auth(actor.accessToken),
      });
      expect(res.status(), await res.text()).toBe(200);

      const body = await payload<Record<string, unknown>>(res);
      expect(body.id).toBe(actor.id);
      expect(body).not.toHaveProperty('passwordHash');
      expect(body).not.toHaveProperty('refreshTokenHash');
      expect(body).not.toHaveProperty('mobileOtpHash');
      expect(
        await res.text(),
        'internal call notes were served to the account holder',
      ).not.toContain('Chased twice');
    }
  });

  test('an API key reaches the profile surface only as its own owner', async ({
    request,
  }) => {
    await onboardCustomer(customer.id);
    const bystander = await createCustomer(request);

    const created = await request.post('/api-keys', {
      data: { label: 'e2e-users' },
      headers: auth(customer.accessToken),
    });
    expect(created.ok(), await created.text()).toBeTruthy();
    const key = await payload<{ key?: string; apiKey?: string }>(created);
    const plaintext = (key.key ?? key.apiKey) as string;
    expect(plaintext, 'no plaintext key came back from creation').toBeTruthy();

    const me = await request.get('/users/me', {
      headers: { 'x-api-key': plaintext },
    });
    expect(me.status(), await me.text()).toBe(200);
    expect((await payload<{ id: string }>(me)).id).toBe(customer.id);

    // Whether a machine credential should be able to rewrite the human's
    // profile at all is a design question (raised in review). Today it can:
    // /users carries no @Roles and no per-key scope, so ApiKeyAuthGuard fills
    // request.user from the owning row and the handler treats the key exactly
    // like the owner's session. Pinned as it behaves — "it only ever acts on
    // the account that owns it" is only worth asserting if the write landed
    // somewhere at all.
    //
    // The probe is firstName because that is what the profile route still
    // writes: companyName came off UpdateUserDto with mobileNumber, websiteUrl
    // and country, so a patch naming it would be stripped and prove nothing.
    const patched = await request.patch('/users/me', {
      data: { firstName: 'Machine Co' },
      headers: { 'x-api-key': plaintext },
    });
    expect(patched.status(), await patched.text()).toBe(200);
    expect((await userRow(customer.id)).firstName).toBe('Machine Co');
    expect(
      (await userRow(bystander.id)).firstName,
      'a key wrote to an account that does not own it',
    ).not.toBe('Machine Co');
  });
});
