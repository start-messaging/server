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
import {
  NOWHERE,
  FIXTURE,
  errorCode,
  balanceOf,
  removeFixtures,
} from './ops-helpers.js';

/**
 * Who may act on the admin operations surface: dashboard, manual wallet
 * credits, tags, channels and OTP templates.
 *
 * admin/overview.spec.ts walks the happy path of these routes. This file goes after
 * the seams instead — the wrong role, and the difference between "no session"
 * and "this session is real but is not an admin".
 */

test.describe('admin ops — who may act', () => {
  let admin: Customer;
  let customer: Customer;

  test.beforeEach(async ({ request }) => {
    await resetDb();
    await removeFixtures();
    admin = await createAdmin(request);
    customer = await createCustomer(request);
    await onboardCustomer(customer.id);
  });

  test.afterEach(async () => {
    await removeFixtures();
  });

  test.afterAll(async () => {
    await closeDb();
  });

  /** Every route in the admin ops scope, including the ones that take an id. */
  const ROUTES: [string, string][] = [
    ['GET', '/admin/dashboard'],
    ['GET', '/admin/dashboard/daily-usage'],
    ['POST', '/admin/wallet/topup'],
    ['GET', '/admin/tags'],
    ['POST', '/admin/tags'],
    ['DELETE', `/admin/tags/${NOWHERE}`],
    ['GET', `/admin/users/${NOWHERE}/tags`],
    ['PUT', `/admin/users/${NOWHERE}/tags`],
    ['GET', '/admin/channels'],
    ['GET', '/admin/templates'],
    ['POST', '/admin/templates'],
    ['GET', `/admin/templates/${NOWHERE}`],
    ['PATCH', `/admin/templates/${NOWHERE}`],
    ['PATCH', `/admin/templates/${NOWHERE}/publish`],
    ['PATCH', `/admin/templates/${NOWHERE}/unpublish`],
    ['DELETE', `/admin/templates/${NOWHERE}`],
  ];

  test('an anonymous caller is refused every route with 401, and a customer with 403', async ({
    request,
  }) => {
    // The two are not interchangeable. 401 says "no session"; 403 says "this
    // session is real but is not an admin". A customer answered 401 would send
    // the panel into a refresh loop, and an anonymous caller answered 403 would
    // tell an unauthenticated prober that the route exists and is admin-only.
    for (const [method, path] of ROUTES) {
      const anonymous = await request.fetch(path, {
        method,
        ...(method === 'GET' ? {} : { data: {} }),
      });
      expect(anonymous.status(), `${method} ${path} as anonymous`).toBe(401);
      expect(await errorCode(anonymous)).toBe('UNAUTHORIZED');

      const asCustomer = await request.fetch(path, {
        method,
        headers: auth(customer.accessToken),
        ...(method === 'GET' ? {} : { data: {} }),
      });
      expect(asCustomer.status(), `${method} ${path} as a customer`).toBe(403);
      expect(await errorCode(asCustomer)).toBe('FORBIDDEN');
    }
  });

  test('a partner session is not a session on this API at all', async ({
    request,
  }) => {
    // Partner tokens are signed with PARTNER_JWT_SECRET, so they do not even
    // decode here — the answer is 401, not 403. Worth pinning: if the two
    // secrets were ever unified by accident, this flips to 403 and the only
    // thing standing between a partner and the admin panel becomes the role
    // claim inside a token minted by a different service.
    const partner = await createPartner(request);

    for (const [method, path] of ROUTES) {
      const res = await request.fetch(path, {
        method,
        headers: auth(partner.accessToken),
        ...(method === 'GET' ? {} : { data: {} }),
      });
      expect(res.status(), `${method} ${path} as a partner`).toBe(401);
    }
  });

  test("a customer's API key cannot reach the admin surface", async ({
    request,
  }) => {
    // The API key path sets request.user from the key's owner, so the role
    // check has something to read. A key that authenticated as roleless would
    // sail past RolesGuard, which compares against `user?.role`.
    const created = await request.post('/api-keys', {
      data: { label: `${FIXTURE}key` },
      headers: auth(customer.accessToken),
    });
    expect(created.ok(), await created.text()).toBeTruthy();
    const key = await payload<{ key: string }>(created);

    const res = await request.get('/admin/dashboard', {
      headers: { 'X-API-Key': key.key },
    });
    expect(res.status(), await res.text()).toBe(403);
    expect(await errorCode(res)).toBe('FORBIDDEN');
  });

  test('the role is checked before the body is looked at', async ({
    request,
  }) => {
    // A customer must not be able to use validation errors as an oracle for
    // what the admin API accepts, and must certainly not move money on the way
    // to being refused. The same body from an admin is answered 400, which is
    // what makes the 403 meaningful rather than incidental.
    const before = await balanceOf(customer.id);
    const body = { email: customer.email, amount: -1, description: 'x' };

    const refused = await request.post('/admin/wallet/topup', {
      data: body,
      headers: auth(customer.accessToken),
    });
    expect(refused.status(), await refused.text()).toBe(403);

    const validated = await request.post('/admin/wallet/topup', {
      data: body,
      headers: auth(admin.accessToken),
    });
    expect(validated.status(), await validated.text()).toBe(400);

    expect(await balanceOf(customer.id)).toBe(before);
  });

  test('promoting an account in the database does not upgrade the token it already holds', async ({
    request,
  }) => {
    // RolesGuard reads the role off the JWT, never off the row. That is the
    // right trade for a stateless token, but it means promotion only takes
    // effect on the next login — and this test exists so that fact is asserted
    // rather than discovered.
    const promoted = await createCustomer(request);
    await sql(`UPDATE "users" SET "role" = 'admin' WHERE "id" = $1`, [
      promoted.id,
    ]);

    const stale = await request.get('/admin/dashboard', {
      headers: auth(promoted.accessToken),
    });
    expect(stale.status(), await stale.text()).toBe(403);

    const login = await request.post('/auth/login', {
      data: { email: promoted.email, password: promoted.password },
    });
    const fresh = await payload<{ accessToken: string }>(login);
    const now = await request.get('/admin/dashboard', {
      headers: auth(fresh.accessToken),
    });
    expect(now.status(), await now.text()).toBe(200);
  });
});
