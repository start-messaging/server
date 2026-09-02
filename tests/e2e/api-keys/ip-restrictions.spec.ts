import { test, expect } from '@playwright/test';
import { resetDb, closeDb } from '../helpers/db.js';
import {
  createCustomer,
  onboardCustomer,
  auth,
  payload,
  Customer,
} from '../helpers/actors.js';
import { CreatedKey, createKey, errorOf, keyRows } from './helpers.js';

/**
 * API keys, at the seams — ip restrictions.
 *
 * api-keys/lifecycle.spec.ts covers the shape of the feature: the plaintext comes
 * back once, a revoked key stops working, one customer cannot touch another's.
 * This file is about the edges of the allow list — what it will accept, and what
 * an edit is allowed to do to it:
 *
 *  - the IP allow list is checked against `req.ip`, which is `trust proxy`'d.
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

  test.describe('ip restrictions', () => {
    test('an address list that is not a list of addresses is refused', async ({
      request,
    }) => {
      const bad = [
        'not-an-ip',
        // A range, which is what an ops team reaches for first. @IsIP wants a
        // single address, so this is a 400 and not a silently ignored rule.
        '203.0.113.0/24',
        '203.0.113.256',
        // Copy-pasted out of a spreadsheet.
        ' 203.0.113.5 ',
        '',
        'localhost',
      ];

      for (const ip of bad) {
        const res = await request.post('/api-keys', {
          data: { label: 'edge', allowedIps: [ip] },
          headers: auth(customer.accessToken),
        });
        expect(res.status(), `accepted "${ip}"`).toBe(400);
        expect((await errorOf(res)).code).toBe('VALIDATION_ERROR');
      }

      // A rejected key must not leave a row behind that authenticates.
      expect((await keyRows(customer.id)).length).toBe(0);
    });

    test('twenty addresses are allowed and twenty-one are not', async ({
      request,
    }) => {
      const twenty = Array.from({ length: 20 }, (_, i) => `203.0.113.${i + 1}`);

      const created = await createKey(request, customer.accessToken, {
        allowedIps: twenty,
      });
      expect(created.allowedIps).toEqual(twenty);

      const overflow = await request.post('/api-keys', {
        data: { label: 'edge', allowedIps: [...twenty, '198.51.100.1'] },
        headers: auth(customer.accessToken),
      });
      expect(overflow.status(), await overflow.text()).toBe(400);

      const rows = await keyRows(customer.id);
      expect(rows.length).toBe(1);
      expect(rows[0].allowedIps).toEqual(twenty);
    });

    test('an empty address list means unrestricted, not locked out', async ({
      request,
    }) => {
      // `[]` normalises to NULL. If it were stored as an empty array the guard
      // would still let everything through (it only checks a non-empty list),
      // but the UI would show a restriction that does not exist.
      const created = await createKey(request, customer.accessToken, {
        allowedIps: [],
      });
      expect(created.allowedIps).toBeNull();

      const [row] = await keyRows(customer.id);
      expect(row.allowedIps).toBeNull();

      const res = await request.get('/api-keys', {
        headers: { 'x-api-key': created.key },
      });
      expect(res.status(), await res.text()).toBe(200);
    });

    test('patching with an empty body clears the restrictions', async ({
      request,
    }) => {
      const created = await createKey(request, customer.accessToken, {
        allowedIps: ['203.0.113.5'],
      });

      // `allowedIps` is @IsOptional, and an omitted field reaches the service
      // as undefined, which normalises to NULL exactly like an explicit null
      // does. So a PATCH that mentions nothing at all removes the allow list.
      // Pinned, not endorsed: a request that asks for no change should make
      // none, least of all a change that widens access.
      const res = await request.patch(
        `/api-keys/${created.id}/ip-restrictions`,
        { data: {}, headers: auth(customer.accessToken) },
      );
      expect(res.status(), await res.text()).toBe(200);

      const [row] = await keyRows(customer.id);
      expect(row.allowedIps).toBeNull();
    });

    test('an explicit null clears the restrictions', async ({ request }) => {
      const created = await createKey(request, customer.accessToken, {
        allowedIps: ['203.0.113.5'],
      });

      const res = await request.patch(
        `/api-keys/${created.id}/ip-restrictions`,
        { data: { allowedIps: null }, headers: auth(customer.accessToken) },
      );
      expect(res.status(), await res.text()).toBe(200);
      expect((await payload<CreatedKey>(res)).allowedIps).toBeNull();

      const [row] = await keyRows(customer.id);
      expect(row.allowedIps).toBeNull();
    });

    test('patching a non-empty allow list persists it and the key is refused from outside it', async ({
      request,
    }) => {
      // The route's primary state change, driven end to end: an unrestricted
      // key is locked to an address that is not the caller's, and the key —
      // which worked moments earlier — stops authenticating. Every other
      // successful PATCH in this suite clears; this is the one that sets.
      const created = await createKey(request, customer.accessToken, {});
      expect(created.allowedIps).toBeNull();

      const before = await request.get('/api-keys', {
        headers: { 'x-api-key': created.key },
      });
      expect(before.status(), await before.text()).toBe(200);

      const res = await request.patch(
        `/api-keys/${created.id}/ip-restrictions`,
        {
          data: { allowedIps: ['203.0.113.5'] },
          headers: auth(customer.accessToken),
        },
      );
      expect(res.status(), await res.text()).toBe(200);
      expect((await payload<CreatedKey>(res)).allowedIps).toEqual([
        '203.0.113.5',
      ]);

      const [row] = await keyRows(customer.id);
      expect(row.allowedIps).toEqual(['203.0.113.5']);

      // Enforcement is only ever tested for lists supplied at creation
      // elsewhere; this is the after-an-update half. The suite runs from
      // 127.0.0.1, which is not on the list, so the key must now be refused —
      // and as the same 401 a wrong key gets (see credential.spec.ts).
      const after = await request.get('/api-keys', {
        headers: { 'x-api-key': created.key },
      });
      expect(
        after.status(),
        'the key still authenticated from an address outside its fresh allow list',
      ).toBe(401);
      expect((await errorOf(after)).code).toBe('UNAUTHORIZED');
    });

    test('a spoofed X-Forwarded-For cannot satisfy the allow list', async ({
      request,
    }) => {
      // The allow list is only a control if the address it checks is one the
      // caller cannot write. `trust proxy` used to be `true`, which trusts the
      // whole chain and takes the LEFTMOST X-Forwarded-For entry — the one an
      // attacker prepends. A leaked key plus one header reached the API from
      // anywhere, and the customer's stated containment never fired.
      //
      // It is now `'loopback'`, so Express walks the header from the right and
      // stops at the first address it does not trust. In production nginx runs
      // on this box and APPENDS the real peer with
      // `$proxy_add_x_forwarded_for`, so whatever the caller sent sits to the
      // left of it and is skipped. The header below is that exact shape: the
      // spoofed address first, the real client last.
      //
      // The real client has to be a routable address, not 127.0.0.1: Express
      // skips every trusted entry from the right, and loopback is trusted, so
      // a test that put the suite's own 127.0.0.1 there had the walk step
      // straight past it and land on the spoof — which is a property of the
      // fixture, not of production, where the caller is out on the internet.
      const created = await createKey(request, customer.accessToken, {
        allowedIps: ['203.0.113.5'],
      });

      const spoofed = await request.get('/api-keys', {
        headers: {
          'x-api-key': created.key,
          'x-forwarded-for': '203.0.113.5, 198.51.100.9',
        },
      });
      expect(
        spoofed.status(),
        'a caller-supplied X-Forwarded-For satisfied the allow list',
      ).toBe(401);
      expect((await errorOf(spoofed)).code).toBe('UNAUTHORIZED');

      // And the genuine article still works: when the rightmost untrusted
      // entry IS the allow-listed address — what nginx produces for a real
      // request from that office — the key authenticates.
      const genuine = await request.get('/api-keys', {
        headers: {
          'x-api-key': created.key,
          'x-forwarded-for': '203.0.113.5',
        },
      });
      expect(genuine.status(), await genuine.text()).toBe(200);
    });

    test('replacing one allow list with another leaves only the new one in force', async ({
      request,
    }) => {
      // The caller's own address, exactly as the guard will read it, so the
      // "new list admits me" half is tested against the same normalisation.
      const mine = await request.get('/api-keys/my-ip', {
        headers: auth(customer.accessToken),
      });
      const { ip } = await payload<{ ip: string }>(mine);

      const created = await createKey(request, customer.accessToken, {
        allowedIps: ['203.0.113.5'],
      });

      const res = await request.patch(
        `/api-keys/${created.id}/ip-restrictions`,
        {
          data: { allowedIps: [ip, '198.51.100.7'] },
          headers: auth(customer.accessToken),
        },
      );
      expect(res.status(), await res.text()).toBe(200);

      // Replaced, not merged: the old address is gone from the stored row.
      const [row] = await keyRows(customer.id);
      expect(row.allowedIps).toEqual([ip, '198.51.100.7']);

      // And the new list actually admits the caller it names.
      const use = await request.get('/api-keys', {
        headers: { 'x-api-key': created.key },
      });
      expect(use.status(), await use.text()).toBe(200);
    });

    test('the patch path enforces the same validation as creation, without touching the list', async ({
      request,
    }) => {
      // The 20-address cap and the malformed-address refusal are only pinned
      // on POST /api-keys elsewhere; a divergence here would let an edit
      // smuggle in what creation refuses.
      const created = await createKey(request, customer.accessToken, {
        allowedIps: ['203.0.113.5'],
      });

      const twentyOne = Array.from(
        { length: 21 },
        (_, i) => `198.51.100.${i + 1}`,
      );
      const overflow = await request.patch(
        `/api-keys/${created.id}/ip-restrictions`,
        {
          data: { allowedIps: twentyOne },
          headers: auth(customer.accessToken),
        },
      );
      expect(overflow.status(), await overflow.text()).toBe(400);
      expect((await errorOf(overflow)).code).toBe('VALIDATION_ERROR');

      const malformed = await request.patch(
        `/api-keys/${created.id}/ip-restrictions`,
        {
          data: { allowedIps: ['203.0.113.0/24'] },
          headers: auth(customer.accessToken),
        },
      );
      expect(malformed.status(), await malformed.text()).toBe(400);
      expect((await errorOf(malformed)).code).toBe('VALIDATION_ERROR');

      // Both refusals must leave the stored list exactly as it was — neither
      // replaced nor cleared, which is the dangerous failure for a field whose
      // empty spelling means "unrestricted".
      const [row] = await keyRows(customer.id);
      expect(row.allowedIps).toEqual(['203.0.113.5']);

      // At the cap itself the patch is legal — the boundary sits at 20, the
      // same place the create path puts it.
      const twenty = Array.from(
        { length: 20 },
        (_, i) => `198.51.100.${i + 1}`,
      );
      const atCap = await request.patch(
        `/api-keys/${created.id}/ip-restrictions`,
        {
          data: { allowedIps: twenty },
          headers: auth(customer.accessToken),
        },
      );
      expect(atCap.status(), await atCap.text()).toBe(200);
      expect((await keyRows(customer.id))[0].allowedIps).toEqual(twenty);
    });

    test('restrictions cannot be edited on a key that has been revoked', async ({
      request,
    }) => {
      const created = await createKey(request, customer.accessToken, {
        allowedIps: ['203.0.113.5'],
      });

      const del = await request.delete(`/api-keys/${created.id}`, {
        headers: auth(customer.accessToken),
      });
      expect(del.status(), await del.text()).toBe(200);

      // Soft delete is a terminal state: the row is still there, and the
      // lookup has to exclude it or a revoked key becomes editable again.
      const res = await request.patch(
        `/api-keys/${created.id}/ip-restrictions`,
        {
          data: { allowedIps: ['198.51.100.1'] },
          headers: auth(customer.accessToken),
        },
      );
      expect(res.status(), await res.text()).toBe(404);
      expect((await errorOf(res)).code).toBe('NOT_FOUND');

      const [row] = await keyRows(customer.id);
      expect(row.allowedIps).toEqual(['203.0.113.5']);
    });
  });
});
