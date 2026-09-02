import { test, expect } from '@playwright/test';
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
  CreatedKey,
  createKey,
  errorOf,
  keyRows,
  sha256,
} from './helpers.js';

/**
 * API keys, at the seams — the secret itself.
 *
 * api-keys/lifecycle.spec.ts covers the shape of the feature: the plaintext comes
 * back once, a revoked key stops working, one customer cannot touch another's.
 * This file is about the edges of that surface — what is actually minted, what is
 * actually stored, and what the create body is allowed to say about it:
 *
 *  - nothing in the model expires, and the create DTO silently swallows an
 *    `expiresAt` because the global pipe whitelists rather than forbids.
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

  test.describe('the secret itself', () => {
    test('the stored row is a sha256 of the key that was handed out', async ({
      request,
    }) => {
      const created = await createKey(request, customer.accessToken);

      // 8-character prefix plus 20 random bytes; the prefix column is 12 chars,
      // so it discloses exactly four characters of the secret and no more.
      expect(created.key).toMatch(/^sm_live_[0-9a-f]{40}$/);
      expect(created.keyPrefix).toBe(created.key.slice(0, 12));

      const [row] = await keyRows(customer.id);
      // Not merely "the plaintext is absent" — the hash on the row has to be
      // the hash *of the key that was returned*. A mismatch would mean the
      // caller was handed a secret that authenticates nothing, or worse, that
      // some other key's hash was stored under this id.
      expect(row.keyHash).toBe(sha256(created.key));
      expect(row.keyPrefix).toBe(created.keyPrefix);
      expect(row.userId).toBe(customer.id);
      expect(row.isActive).toBe(true);
      expect(row.allowedIps).toBeNull();
      expect(row.lastUsedAt).toBeNull();
    });

    test('nothing a later read returns can be replayed as a credential', async ({
      request,
    }) => {
      const created = await createKey(request, customer.accessToken);

      for (const path of [
        '/api-keys',
        '/dashboard/api-keys',
        '/api-keys/usage-guide',
      ]) {
        const res = await request.get(path, {
          headers: auth(customer.accessToken),
        });
        expect(res.status(), await res.text()).toBe(200);
        expect(
          JSON.stringify(await payload(res)),
          `${path} handed the plaintext key back`,
        ).not.toContain(created.key);
      }

      // The listing ships the whole row, hash included. That is only harmless
      // for as long as none of it authenticates, so try each field as a
      // credential rather than trusting that it does not.
      const [row] = await keyRows(customer.id);
      for (const candidate of [row.keyHash, row.keyPrefix, row.id]) {
        const res = await request.get('/api-keys', {
          headers: { 'x-api-key': candidate },
        });
        expect(res.status(), `"${candidate}" authenticated`).toBe(401);
      }
    });

    test('two keys minted at the same instant are two different secrets', async ({
      request,
    }) => {
      const [a, b] = await Promise.all([
        createKey(request, customer.accessToken, { label: 'a' }),
        createKey(request, customer.accessToken, { label: 'b' }),
      ]);

      expect(a.id).not.toBe(b.id);
      expect(a.key).not.toBe(b.key);

      const rows = await keyRows(customer.id);
      expect(rows.length).toBe(2);
      expect(new Set(rows.map((r) => r.keyHash)).size).toBe(2);

      // Both have to work; a race that overwrote one row with the other's hash
      // would still leave two ids and two responses.
      for (const key of [a.key, b.key]) {
        const res = await request.get('/api-keys', {
          headers: { 'x-api-key': key },
        });
        expect(res.status(), await res.text()).toBe(200);
      }
    });

    test('unknown fields in the create body are dropped rather than honoured', async ({
      request,
    }) => {
      const other = await createCustomer(request);

      // The global pipe whitelists but does not forbid, so none of this is a
      // 400 — it is silently discarded. That is fine for `keyHash`, and a trap
      // for `expiresAt`: a client that believes it asked for a key that dies in
      // a year is handed one that never does.
      const res = await request.post('/api-keys', {
        data: {
          label: 'mass-assignment',
          id: ABSENT_UUID,
          userId: other.id,
          keyHash: 'deadbeef',
          keyPrefix: 'sm_live_evil',
          isActive: false,
          expiresAt: '2020-01-01T00:00:00.000Z',
          scopes: ['admin'],
        },
        headers: auth(customer.accessToken),
      });
      expect(res.status(), await res.text()).toBe(201);
      const created = await payload<CreatedKey>(res);

      expect(created.id).not.toBe(ABSENT_UUID);

      const [row] = await keyRows(customer.id);
      expect(row.userId).toBe(customer.id);
      expect(row.keyHash).toBe(sha256(created.key));
      expect(row.keyPrefix).toBe(created.key.slice(0, 12));
      expect(row.isActive).toBe(true);
      expect((await keyRows(other.id)).length).toBe(0);

      // And the key really is immortal: there is no expiry column to have set.
      const columns = await sql<{ column_name: string }>(
        `SELECT "column_name" FROM information_schema.columns
          WHERE "table_schema" = 'public' AND "table_name" = 'api_keys'`,
      );
      expect(
        columns.map((c) => c.column_name).filter((c) => /expir/i.test(c)),
      ).toEqual([]);
    });

    test('a label is optional and is stored exactly as it was sent', async ({
      request,
    }) => {
      const omitted = await request.post('/api-keys', {
        data: {},
        headers: auth(customer.accessToken),
      });
      expect(omitted.status(), await omitted.text()).toBe(201);
      expect((await payload<CreatedKey>(omitted)).label).toBe('');

      // null is not the same input as an omitted field, and both have to land
      // on the NOT NULL column as ''.
      const nulled = await createKey(request, customer.accessToken, {
        label: null,
      });
      expect(nulled.label).toBe('');

      // No trim, no normalisation: a label is display text the customer chose,
      // and silently rewriting it makes two keys look identical in the UI.
      const odd = '  Prod ✅ ключ 🔑  ';
      const kept = await createKey(request, customer.accessToken, {
        label: odd,
      });
      expect(kept.label).toBe(odd);

      // Compared as a set: three creates a few milliseconds apart is not a
      // reliable ordering to assert on, and the ordering is not the point here.
      const rows = await keyRows(customer.id);
      expect(rows.length).toBe(3);
      expect(rows.filter((r) => r.label === '').length).toBe(2);
      expect(rows.filter((r) => r.label === odd).length).toBe(1);
    });

    test('an absurdly long label is accepted whole', async ({ request }) => {
      // Nothing bounds this. `CreateApiKeyDto.label` carries @IsString and no
      // @MaxLength, and the column is an unbounded `character varying`, so the
      // only outcome the code allows is a 201 storing all five thousand
      // characters on a row every dashboard load reads back. Pinned, not
      // endorsed: adding a limit should fail here rather than silently start
      // truncating labels customers chose.
      const long = 'L'.repeat(5000);
      const res = await request.post('/api-keys', {
        data: { label: long },
        headers: auth(customer.accessToken),
      });
      expect(res.status(), await res.text()).toBe(201);
      expect((await payload<CreatedKey>(res)).label).toBe(long);

      const [row] = await keyRows(customer.id);
      expect(row.label.length).toBe(5000);
    });

    test('fields of the wrong type are refused rather than coerced into a row', async ({
      request,
    }) => {
      const cases: Array<Record<string, unknown>> = [
        // An array where a scalar belongs. `label: string` emits a `String`
        // design:type, and implicit conversion maps over an array rather than
        // collapsing it, so @IsString is still handed an array.
        { label: ['a', 'b'] },
        // A scalar where an array belongs. `allowedIps: string[] | null` emits
        // an `Object` design:type — a union with null always does — so implicit
        // conversion has no scalar target to coerce towards and passes the
        // value through untouched. All three cases below therefore reach
        // @IsArray and @IsIP as the literal JSON that was sent.
        { allowedIps: '203.0.113.5' },
        // Right container, wrong element type.
        { allowedIps: [1234] },
        { allowedIps: [{ ip: '203.0.113.5' }] },
      ];

      for (const data of cases) {
        const res = await request.post('/api-keys', {
          data,
          headers: auth(customer.accessToken),
        });
        expect(res.status(), `accepted ${JSON.stringify(data)}`).toBe(400);
        expect((await errorOf(res)).code).toBe('VALIDATION_ERROR');
      }

      expect((await keyRows(customer.id)).length).toBe(0);
    });
  });
});
