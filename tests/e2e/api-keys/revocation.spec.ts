import { test, expect } from '@playwright/test';
import { resetDb, closeDb } from '../helpers/db.js';
import {
  createCustomer,
  onboardCustomer,
  auth,
  payload,
  Customer,
} from '../helpers/actors.js';
import { createKey, errorOf, keyRows } from './helpers.js';

/**
 * API keys, at the seams — revocation.
 *
 * api-keys/lifecycle.spec.ts covers the shape of the feature: the plaintext comes
 * back once, a revoked key stops working, one customer cannot touch another's.
 * This file is about the edges of the revoke itself — doing it twice, doing it
 * three times at once, and what the soft delete deliberately leaves behind.
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

  test.describe('revocation', () => {
    test('deleting the same key twice answers not-found the second time', async ({
      request,
    }) => {
      const created = await createKey(request, customer.accessToken);

      const first = await request.delete(`/api-keys/${created.id}`, {
        headers: auth(customer.accessToken),
      });
      expect(first.status(), await first.text()).toBe(200);

      const second = await request.delete(`/api-keys/${created.id}`, {
        headers: auth(customer.accessToken),
      });
      expect(second.status(), await second.text()).toBe(404);
      expect((await errorOf(second)).code).toBe('NOT_FOUND');

      const rows = await keyRows(customer.id);
      expect(rows.length).toBe(1);
      expect(rows[0].deletedAt).not.toBeNull();
    });

    test('concurrent deletes of one key never produce a server error', async ({
      request,
    }) => {
      const created = await createKey(request, customer.accessToken);

      // A double-clicked revoke button. Both requests read the row before
      // either writes, so the second write lands on an already-deleted row.
      const results = await Promise.all(
        [0, 1, 2].map(() =>
          request.delete(`/api-keys/${created.id}`, {
            headers: auth(customer.accessToken),
          }),
        ),
      );

      for (const res of results) {
        expect([200, 404], await res.text()).toContain(res.status());
      }
      expect(results.some((r) => r.status() === 200)).toBe(true);

      const rows = await keyRows(customer.id);
      expect(rows.length).toBe(1);
      expect(rows[0].deletedAt).not.toBeNull();

      const replay = await request.get('/api-keys', {
        headers: { 'x-api-key': created.key },
      });
      expect(replay.status(), 'a revoked key still authenticated').toBe(401);
    });

    test('a revoked key leaves the listing but not the table', async ({
      request,
    }) => {
      const doomed = await createKey(request, customer.accessToken, {
        label: 'doomed',
      });
      const survivor = await createKey(request, customer.accessToken, {
        label: 'survivor',
      });

      await request.delete(`/api-keys/${doomed.id}`, {
        headers: auth(customer.accessToken),
      });

      const list = await request.get('/api-keys', {
        headers: auth(customer.accessToken),
      });
      const listed = await payload<Array<{ id: string }>>(list);
      expect(listed.map((k) => k.id)).toEqual([survivor.id]);

      // The row survives on purpose: messages reference `apiKeyId`, and a hard
      // delete would strip the audit trail of every send the key ever made.
      const rows = await keyRows(customer.id);
      expect(rows.length).toBe(2);
      expect(rows.filter((r) => r.deletedAt !== null).length).toBe(1);
    });
  });
});
