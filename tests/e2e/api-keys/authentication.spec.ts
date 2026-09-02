import { test, expect, APIResponse } from '@playwright/test';
import { resetDb, closeDb, sql } from '../helpers/db.js';
import {
  createCustomer,
  onboardCustomer,
  auth,
  payload,
  Customer,
} from '../helpers/actors.js';
import {
  ABSENT_UUID,
  createKey,
  errorOf,
  keyRows,
  mintToken,
} from './helpers.js';

/**
 * API keys, at the seams — authentication.
 *
 * api-keys/lifecycle.spec.ts covers the shape of the feature: the plaintext comes
 * back once, a revoked key stops working, one customer cannot touch another's.
 * This file is about the edges of the guards in front of that surface — who is
 * turned away, who is waved through, and what happens to a session and a key when
 * the account behind them is switched off.
 *
 * Where the behaviour below looks wrong it is pinned, not corrected: a failing
 * assertion here would say "the product changed", which is the only useful
 * thing a test can say about a defect it cannot fix.
 */

test.describe('api key edge cases', () => {
  let customer: Customer;

  test.beforeEach(async ({ request }) => {
    await resetDb();
    customer = await createCustomer(request);
    // Every /api-keys route sits behind OnboardingGuard, so an account that
    // has not been approved cannot reach any of them. That gate is asserted on
    // its own further down; everywhere else it is just a precondition.
    await onboardCustomer(customer.id);
  });

  test.afterAll(async () => {
    await closeDb();
  });

  test.describe('authentication seams', () => {
    test('every key route refuses an anonymous caller', async ({ request }) => {
      const routes: Array<Promise<APIResponse>> = [
        request.get('/api-keys'),
        request.post('/api-keys', { data: { label: 'x' } }),
        // Both of these look like public helpers — one echoes an IP, the other
        // returns static documentation — and both are behind the guard.
        request.get('/api-keys/my-ip'),
        request.get('/api-keys/usage-guide'),
        request.patch(`/api-keys/${ABSENT_UUID}/ip-restrictions`, {
          data: { allowedIps: [] },
        }),
        request.delete(`/api-keys/${ABSENT_UUID}`),
      ];

      for (const res of await Promise.all(routes)) {
        expect(res.status(), await res.text()).toBe(401);
        expect((await errorOf(res)).code).toBe('UNAUTHORIZED');
      }
    });

    test('a forged, expired or unsigned token cannot manage keys', async ({
      request,
    }) => {
      test.skip(
        !process.env.JWT_SECRET,
        'JWT_SECRET is not in the environment, so tokens cannot be minted',
      );

      const now = Math.floor(Date.now() / 1000);
      const claims = {
        sub: customer.id,
        email: customer.email,
        role: 'customer',
      };

      // Control first. Without it a broken minter would make every assertion
      // below pass for the wrong reason.
      const valid = mintToken({ ...claims, iat: now, exp: now + 900 });
      const control = await request.get('/api-keys', { headers: auth(valid) });
      expect(control.status(), await control.text()).toBe(200);

      // Someone else's subject in the claim set, carrying the signature that
      // was computed over the original one.
      const swapped = mintToken({
        ...claims,
        sub: ABSENT_UUID,
        iat: now,
        exp: now + 900,
      });
      const tampered = `${swapped.split('.').slice(0, 2).join('.')}.${
        valid.split('.')[2]
      }`;

      const rejected: Record<string, string> = {
        expired: mintToken({ ...claims, iat: now - 3600, exp: now - 60 }),
        'wrong secret': mintToken(
          { ...claims, iat: now, exp: now + 900 },
          { secret: 'not-the-servers-secret' },
        ),
        unsigned: mintToken(
          { ...claims, iat: now, exp: now + 900 },
          { alg: 'none', signature: '' },
        ),
        'payload swapped after signing': tampered,
      };

      for (const [name, token] of Object.entries(rejected)) {
        const res = await request.post('/api-keys', {
          data: { label: name },
          headers: auth(token),
        });
        expect(res.status(), `${name} token was accepted`).toBe(401);
      }

      // The control was a read, and none of the four rejected requests may
      // have got as far as the service.
      expect((await keyRows(customer.id)).length).toBe(0);
    });

    test('a signed token naming a user that does not exist reads an empty list', async ({
      request,
    }) => {
      test.skip(
        !process.env.JWT_SECRET,
        'JWT_SECRET is not in the environment, so tokens cannot be minted',
      );

      // JwtStrategy trusts the claim set without loading the subject, and
      // OnboardingGuard waves through a subject it cannot find. Deactivation is
      // caught (see below) precisely because that row exists to be read; a
      // missing row is the case nothing checks.
      const now = Math.floor(Date.now() / 1000);
      const ghost = mintToken({
        sub: ABSENT_UUID,
        email: 'ghost@example.com',
        role: 'customer',
        iat: now,
        exp: now + 900,
      });

      const res = await request.get('/api-keys', { headers: auth(ghost) });
      expect(res.status(), await res.text()).toBe(200);
      expect(await payload<unknown[]>(res)).toEqual([]);
    });

    test('a deactivated account loses its session and its keys at once', async ({
      request,
    }) => {
      const created = await createKey(request, customer.accessToken);
      await sql(`UPDATE "users" SET "isActive" = false WHERE "id" = $1`, [
        customer.id,
      ]);

      // The access token is still valid and still unexpired; the guard that
      // loads the row is what stops it.
      const session = await request.get('/api-keys', {
        headers: auth(customer.accessToken),
      });
      expect(session.status(), await session.text()).toBe(403);
      expect((await errorOf(session)).message).toBe(
        'This account has been deactivated.',
      );

      // The key is a second door into the same account and has to close too,
      // through a different guard and with a different answer.
      const viaKey = await request.get('/api-keys', {
        headers: { 'x-api-key': created.key },
      });
      expect(viaKey.status(), await viaKey.text()).toBe(401);
      expect((await errorOf(viaKey)).message).toBe('Account is suspended');
    });

    test('a customer who has not finished onboarding cannot even read the usage guide', async ({
      request,
    }) => {
      const fresh = await createCustomer(request);

      for (const path of ['/api-keys', '/api-keys/usage-guide']) {
        const res = await request.get(path, {
          headers: auth(fresh.accessToken),
        });
        expect(res.status(), `${path}: ${await res.text()}`).toBe(403);

        const error = await errorOf(res);
        expect(error.message).toBe('Mobile verification required');
        // OnboardingGuard raises `errorCode: ONBOARDING_INCOMPLETE` with a
        // `currentStep`, but the exception filter reads `code`, so both are
        // dropped and the client sees a bare FORBIDDEN. Pinned so that a fix
        // is a deliberate change rather than a surprise to the dashboard.
        expect(error.code).toBe('FORBIDDEN');
      }
    });
  });
});
