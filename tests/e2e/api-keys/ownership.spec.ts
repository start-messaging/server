import { test, expect } from '@playwright/test';
import { resetDb, closeDb, sql } from '../helpers/db.js';
import {
  createAdmin,
  createCustomer,
  createPartner,
  onboardCustomer,
  auth,
  payload,
  Customer,
} from '../helpers/actors.js';
import { ABSENT_UUID, createKey, errorOf, keyRows } from './helpers.js';

/**
 * API keys, at the seams — identifiers and ownership.
 *
 * api-keys/lifecycle.spec.ts covers the shape of the feature: the plaintext comes
 * back once, a revoked key stops working, one customer cannot touch another's.
 * This file is about the edges of that last one — what a malformed id does, and
 * what a caller who is not the owner is allowed to learn about a key that is not
 * theirs.
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

  test.describe('identifiers and ownership', () => {
    test('a non-uuid key id is a bad request, not a cast error', async ({
      request,
    }) => {
      for (const id of [
        'not-a-uuid',
        '123',
        'null',
        // One character short of a real uuid — the shape that gets through a
        // hand-rolled regex and dies in Postgres.
        '00000000-0000-4000-8000-00000000dea',
      ]) {
        const del = await request.delete(`/api-keys/${id}`, {
          headers: auth(customer.accessToken),
        });
        expect(del.status(), `DELETE ${id}: ${await del.text()}`).toBe(400);
        expect((await errorOf(del)).code).toBe('INVALID_INPUT');

        const patch = await request.patch(`/api-keys/${id}/ip-restrictions`, {
          data: { allowedIps: ['203.0.113.5'] },
          headers: auth(customer.accessToken),
        });
        expect(patch.status(), `PATCH ${id}: ${await patch.text()}`).toBe(400);
      }
    });

    test("another customer's key is indistinguishable from one that never existed", async ({
      request,
    }) => {
      const created = await createKey(request, customer.accessToken);
      const intruder = await createCustomer(request);
      await onboardCustomer(intruder.id);

      const someoneElses = await request.delete(`/api-keys/${created.id}`, {
        headers: auth(intruder.accessToken),
      });
      const imaginary = await request.delete(`/api-keys/${ABSENT_UUID}`, {
        headers: auth(intruder.accessToken),
      });

      expect(someoneElses.status()).toBe(404);
      expect(imaginary.status()).toBe(404);
      // Byte-identical: a different message for "exists but is not yours"
      // confirms to an intruder that an id is real.
      expect(await errorOf(someoneElses)).toEqual(await errorOf(imaginary));
      expect((await errorOf(someoneElses)).code).toBe('NOT_FOUND');

      const [row] = await keyRows(customer.id);
      expect(row.deletedAt).toBeNull();
    });

    test('an admin cannot reach a customer key through the customer route', async ({
      request,
    }) => {
      const created = await createKey(request, customer.accessToken);
      const admin = await createAdmin(request);

      // /api-keys is self-scoped for everyone. An admin who needs to see these
      // has an admin route for it; this one must not widen just because the
      // caller's role does.
      const list = await request.get('/api-keys', {
        headers: auth(admin.accessToken),
      });
      expect(list.status(), await list.text()).toBe(200);
      expect(await payload<unknown[]>(list)).toEqual([]);

      const del = await request.delete(`/api-keys/${created.id}`, {
        headers: auth(admin.accessToken),
      });
      expect(del.status(), await del.text()).toBe(404);

      const patch = await request.patch(
        `/api-keys/${created.id}/ip-restrictions`,
        {
          data: { allowedIps: ['203.0.113.5'] },
          headers: auth(admin.accessToken),
        },
      );
      expect(patch.status(), await patch.text()).toBe(404);

      const [row] = await keyRows(customer.id);
      expect(row.deletedAt).toBeNull();
      expect(row.allowedIps).toBeNull();
    });

    test('a partner portal token cannot manage API keys', async ({
      request,
    }) => {
      const partner = await createPartner(request);

      // Partner tokens are signed with their own secret and carry an audience
      // claim, so they cannot verify here at all — and a partner has no row in
      // `users` for a key to hang off.
      for (const res of [
        await request.get('/api-keys', { headers: auth(partner.accessToken) }),
        await request.post('/api-keys', {
          data: { label: 'partner' },
          headers: auth(partner.accessToken),
        }),
      ]) {
        expect(res.status(), await res.text()).toBe(401);
        expect((await errorOf(res)).code).toBe('UNAUTHORIZED');
      }

      const [{ count }] = await sql<{ count: string }>(
        `SELECT COUNT(*)::int AS count FROM "api_keys"`,
      );
      expect(Number(count)).toBe(0);
    });
  });
});
