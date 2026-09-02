import { test, expect } from '@playwright/test';
import { resetDb, closeDb, sql } from '../helpers/db.js';
import {
  createCustomer,
  onboardCustomer,
  auth,
  payload,
  Customer,
} from '../helpers/actors.js';

/**
 * API keys, at the seams — listing.
 *
 * api-keys/lifecycle.spec.ts covers the shape of the feature: the plaintext comes
 * back once, a revoked key stops working, one customer cannot touch another's.
 * This file is about the edge of the read side — what happens to an account that
 * has accumulated more keys than the listing will return.
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

  test.describe('listing', () => {
    test('the listing is capped at one hundred keys, newest first', async ({
      request,
    }) => {
      // Seeded directly: the point is the read cap, and 105 round trips would
      // pay a minute of HTTP for nothing. Distinct createdAt values make the
      // ordering assertion deterministic.
      await sql(
        `INSERT INTO "api_keys"
           ("userId", "keyPrefix", "keyHash", "label", "createdAt", "updatedAt")
         SELECT $1, 'sm_live_bulk', md5(g::text), 'bulk-' || g,
                now() - (g * interval '1 minute'), now()
           FROM generate_series(1, 105) AS g`,
        [customer.id],
      );

      const res = await request.get('/api-keys', {
        headers: auth(customer.accessToken),
      });
      expect(res.status(), await res.text()).toBe(200);

      const listed = await payload<Array<{ label: string }>>(res);
      expect(listed.length).toBe(100);
      expect(listed[0].label).toBe('bulk-1');
      expect(listed[99].label).toBe('bulk-100');
      for (const dropped of ['bulk-101', 'bulk-105']) {
        expect(listed.map((k) => k.label)).not.toContain(dropped);
      }

      // A read cap, not a write cap: the rows are all still there, so nothing
      // above the hundredth key is unreachable to the admin views.
      const [{ count }] = await sql<{ count: string }>(
        `SELECT COUNT(*)::int AS count FROM "api_keys" WHERE "userId" = $1`,
        [customer.id],
      );
      expect(Number(count)).toBe(105);
    });
  });
});
