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
import { CreatedKey, createKey, errorOf, seedWallet } from './helpers.js';

/**
 * API keys, at the seams — the key as a credential.
 *
 * api-keys/lifecycle.spec.ts covers the shape of the feature: the plaintext comes
 * back once, a revoked key stops working, one customer cannot touch another's.
 * This file is about the edges of that surface — the ones where an API key is
 * not a "key" at all but a full account credential:
 *
 *  - the key authenticates every route the JWT does, including these ones, so
 *    a leaked key can mint replacements for itself;
 *  - the IP allow list is checked against `req.ip`, which is `trust proxy`'d;
 *  - the guard's own 403 is discarded by CombinedAuthGuard, so an allow-list
 *    rejection reaches the customer as a bare 401.
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
    // its own in tests/e2e/api-keys/authentication.spec.ts; everywhere else it
    // is just a precondition.
    await onboardCustomer(customer.id);
  });

  test.afterAll(async () => {
    await closeDb();
  });

  test.describe('the key as a credential', () => {
    test('an API key can mint another API key, so revoking the first does not contain it', async ({
      request,
    }) => {
      const leaked = await createKey(request, customer.accessToken, {
        label: 'leaked',
      });

      // CombinedAuthGuard accepts x-api-key on every non-public route, and
      // /api-keys is not special-cased. A key issued to send OTPs can therefore
      // issue further keys, which is the whole containment problem below.
      const minted = await request.post('/api-keys', {
        data: { label: 'minted-by-the-leaked-key' },
        headers: { 'x-api-key': leaked.key },
      });
      expect(minted.status(), await minted.text()).toBe(201);
      const second = await payload<CreatedKey>(minted);

      const del = await request.delete(`/api-keys/${leaked.id}`, {
        headers: auth(customer.accessToken),
      });
      expect(del.status(), await del.text()).toBe(200);

      const oldKey = await request.get('/api-keys', {
        headers: { 'x-api-key': leaked.key },
      });
      expect(oldKey.status()).toBe(401);

      // Revoking the key that was leaked leaves the replacement alive.
      const newKey = await request.get('/api-keys', {
        headers: { 'x-api-key': second.key },
      });
      expect(newKey.status(), await newKey.text()).toBe(200);
      expect(
        (await payload<Array<{ id: string }>>(newKey)).map((k) => k.id),
      ).toEqual([second.id]);
    });

    test('an API key inherits the role of its owner', async ({ request }) => {
      const admin = await createAdmin(request);
      const adminKey = await createKey(request, admin.accessToken, {
        label: 'admin key',
      });
      const customerKey = await createKey(request, customer.accessToken);

      // RolesGuard reads the role off request.user, which ApiKeyAuthGuard fills
      // from the owning user's row. An admin's API key is therefore a static,
      // never-expiring admin credential, and a customer's is still only a
      // customer's.
      const asAdmin = await request.get('/admin/affiliate/settings', {
        headers: { 'x-api-key': adminKey.key },
      });
      expect(asAdmin.status(), await asAdmin.text()).toBe(200);

      const asCustomer = await request.get('/admin/affiliate/settings', {
        headers: { 'x-api-key': customerKey.key },
      });
      expect(asCustomer.status(), await asCustomer.text()).toBe(403);
    });

    test('the address my-ip reports is the address the allow list accepts', async ({
      request,
    }) => {
      // my-ip exists so a customer can fill in their allow list. If the two
      // read the caller's address differently — one through the proxy chain,
      // the other not — following the documented flow locks the customer out
      // of their own key.
      const mine = await request.get('/api-keys/my-ip', {
        headers: auth(customer.accessToken),
      });
      expect(mine.status(), await mine.text()).toBe(200);
      const { ip } = await payload<{ ip: string }>(mine);
      expect(ip).toBeTruthy();
      expect(ip.startsWith('::ffff:')).toBe(false);

      const created = await createKey(request, customer.accessToken, {
        allowedIps: [ip],
      });
      await seedWallet(customer.id);

      const res = await request.post('/otp/send', {
        data: { phoneNumber: '+919876543211', variables: { otp: '123456' } },
        headers: { 'x-api-key': created.key },
      });
      expect(
        res.status(),
        `my-ip reported ${ip} but the guard refused it: ${await res.text()}`,
      ).toBe(201);
    });

    test('a key restricted to another address is refused as unauthenticated, not forbidden', async ({
      request,
    }) => {
      const created = await createKey(request, customer.accessToken, {
        allowedIps: ['203.0.113.5'],
      });
      await seedWallet(customer.id);

      const res = await request.post('/otp/send', {
        data: { phoneNumber: '+919876543212', variables: { otp: '123456' } },
        headers: { 'x-api-key': created.key },
      });

      // The guard raises a 403 that names the reason. CombinedAuthGuard
      // re-throws only UnauthorizedException, so that 403 is swallowed and the
      // caller is told "Authentication required" — indistinguishable from a
      // typo'd key. Pinned: the customer-visible reason is what the support
      // load depends on.
      expect(res.status(), await res.text()).toBe(401);
      const error = await errorOf(res);
      expect(error.code).toBe('UNAUTHORIZED');
      expect(error.message).toBe('Authentication required');

      const [{ count }] = await sql<{ count: string }>(
        `SELECT COUNT(*)::int AS count FROM "messages"`,
      );
      expect(Number(count)).toBe(0);
    });

    test('my-ip repeats a client-supplied forwarded-for header', async ({
      request,
    }) => {
      // `trust proxy` is on unconditionally, so req.ip is the left-most entry
      // of X-Forwarded-For — a header any client can set. Both my-ip and the
      // allow-list check read it, which makes an IP restriction advisory
      // rather than enforced. Pinned so that hardening the proxy chain shows
      // up here first.
      const res = await request.get('/api-keys/my-ip', {
        headers: {
          ...auth(customer.accessToken),
          'X-Forwarded-For': '203.0.113.9',
        },
      });
      expect(res.status(), await res.text()).toBe(200);
      expect((await payload<{ ip: string }>(res)).ip).toBe('203.0.113.9');
    });

    test('revoking a key does not erase which key sent a message', async ({
      request,
    }) => {
      const created = await createKey(request, customer.accessToken);
      await seedWallet(customer.id);

      const send = await request.post('/otp/send', {
        data: { phoneNumber: '+919876543213', variables: { otp: '123456' } },
        headers: { 'x-api-key': created.key },
      });
      expect(send.status(), await send.text()).toBe(201);

      const [before] = await sql<{ id: string; apiKeyId: string | null }>(
        `SELECT "id", "apiKeyId" FROM "messages" WHERE "userId" = $1`,
        [customer.id],
      );
      expect(before.apiKeyId).toBe(created.id);

      const del = await request.delete(`/api-keys/${created.id}`, {
        headers: auth(customer.accessToken),
      });
      expect(del.status(), await del.text()).toBe(200);

      // Revocation is the moment someone starts asking what the key did. A
      // cascade here would delete the evidence along with the credential.
      const [after] = await sql<{ id: string; apiKeyId: string | null }>(
        `SELECT "id", "apiKeyId" FROM "messages" WHERE "id" = $1`,
        [before.id],
      );
      expect(after.apiKeyId).toBe(created.id);
    });
  });
});
