import { test, expect } from '@playwright/test';
import { resetDb, closeDb, sql } from '../helpers/db.js';
import {
  createCustomer,
  onboardCustomer,
  auth,
  payload,
  Customer,
} from '../helpers/actors.js';
import { seedLedger } from '../helpers/wallet.js';

/**
 * API keys — the credential machine clients authenticate OTP sends with.
 *
 * The key is shown once at creation and only its hash is kept, so the two
 * things that matter are that the plaintext is never retrievable afterwards
 * and that one customer's key can never touch another customer's account.
 */
test.describe('api keys', () => {
  let customer: Customer;

  test.beforeEach(async ({ request }) => {
    await resetDb();
    customer = await createCustomer(request);
    await onboardCustomer(customer.id);
  });

  test.afterAll(async () => {
    await closeDb();
  });

  async function createKey(
    request: Parameters<typeof createCustomer>[0],
    token: string,
    body: Record<string, unknown> = {},
  ) {
    const res = await request.post('/api-keys', {
      data: { label: 'e2e', ...body },
      headers: auth(token),
    });
    expect(res.ok(), await res.text()).toBeTruthy();
    return payload<{ id: string; key?: string; apiKey?: string }>(res);
  }

  test('creating a key returns the plaintext exactly once', async ({
    request,
  }) => {
    const created = await createKey(request, customer.accessToken);
    const plaintext = created.key ?? created.apiKey;
    expect(plaintext, 'the key was not returned at creation').toBeTruthy();

    // Listing must never hand it back again.
    const list = await request.get('/api-keys', {
      headers: auth(customer.accessToken),
    });
    expect(list.ok()).toBeTruthy();
    expect(JSON.stringify(await payload(list))).not.toContain(
      plaintext as string,
    );
  });

  test('only a hash of the key is stored', async ({ request }) => {
    const created = await createKey(request, customer.accessToken);
    const plaintext = (created.key ?? created.apiKey) as string;

    const rows = await sql<Record<string, unknown>>(
      `SELECT * FROM "api_keys" WHERE "userId" = $1`,
      [customer.id],
    );
    expect(rows.length).toBe(1);
    expect(
      JSON.stringify(rows[0]),
      'the API key is recoverable from the database',
    ).not.toContain(plaintext);
  });

  test('a key authenticates an OTP send', async ({ request }) => {
    const created = await createKey(request, customer.accessToken);
    const plaintext = (created.key ?? created.apiKey) as string;

    await seedLedger(customer.id, {
      to: 500,
      description: 'e2e fixture adjustment',
    });

    const res = await request.post('/otp/send', {
      data: {
        phoneNumber: '+919876543210',
        variables: { otp: '123456' },
      },
      headers: { 'x-api-key': plaintext },
    });
    expect(res.ok(), await res.text()).toBeTruthy();

    const [message] = await sql<{ userId: string }>(
      `SELECT "userId" FROM "messages" ORDER BY "createdAt" DESC LIMIT 1`,
    );
    expect(message.userId).toBe(customer.id);
  });

  test('a revoked key stops working', async ({ request }) => {
    const created = await createKey(request, customer.accessToken);
    const plaintext = (created.key ?? created.apiKey) as string;

    const del = await request.delete(`/api-keys/${created.id}`, {
      headers: auth(customer.accessToken),
    });
    expect(del.ok(), await del.text()).toBeTruthy();

    const res = await request.post('/otp/send', {
      data: { phoneNumber: '+919876543210', variables: { otp: '123456' } },
      headers: { 'x-api-key': plaintext },
    });
    expect(res.ok(), 'a deleted API key still authenticated').toBeFalsy();
  });

  test('a garbage key is rejected', async ({ request }) => {
    for (const key of ['', 'nope', 'sk_live_' + 'a'.repeat(40)]) {
      const res = await request.post('/otp/send', {
        data: { phoneNumber: '+919876543210', variables: { otp: '123456' } },
        headers: { 'x-api-key': key },
      });
      expect(res.ok(), `key "${key}" was accepted`).toBeFalsy();
    }
  });

  test('keys are listed per owner only', async ({ request }) => {
    await createKey(request, customer.accessToken);

    const other = await createCustomer(request);
    await onboardCustomer(other.id);

    const res = await request.get('/api-keys', {
      headers: auth(other.accessToken),
    });
    expect(res.ok()).toBeTruthy();
    expect((await payload<unknown[]>(res)).length).toBe(0);
  });

  test('one customer cannot delete another customer key', async ({
    request,
  }) => {
    const created = await createKey(request, customer.accessToken);

    const other = await createCustomer(request);
    await onboardCustomer(other.id);

    const res = await request.delete(`/api-keys/${created.id}`, {
      headers: auth(other.accessToken),
    });
    expect(res.ok(), 'deleted another user key').toBeFalsy();

    const [{ count }] = await sql<{ count: string }>(
      `SELECT COUNT(*)::int AS count FROM "api_keys" WHERE "id" = $1 AND "deletedAt" IS NULL`,
      [created.id],
    );
    expect(Number(count)).toBe(1);
  });

  test('one customer cannot change another customer IP restrictions', async ({
    request,
  }) => {
    const created = await createKey(request, customer.accessToken);

    const other = await createCustomer(request);
    await onboardCustomer(other.id);

    const res = await request.patch(`/api-keys/${created.id}/ip-restrictions`, {
      data: { allowedIps: ['203.0.113.5'] },
      headers: auth(other.accessToken),
    });
    expect(res.ok(), 'changed another user IP restrictions').toBeFalsy();
  });

  test('IP restrictions reject a malformed address', async ({ request }) => {
    const created = await createKey(request, customer.accessToken);

    const res = await request.patch(`/api-keys/${created.id}/ip-restrictions`, {
      data: { allowedIps: ['not-an-ip'] },
      headers: auth(customer.accessToken),
    });
    expect(res.status()).toBe(400);
  });

  test('a key restricted to another IP cannot send', async ({ request }) => {
    const created = await createKey(request, customer.accessToken, {
      allowedIps: ['203.0.113.5'],
    });
    const plaintext = (created.key ?? created.apiKey) as string;

    await seedLedger(customer.id, {
      to: 500,
      description: 'e2e fixture adjustment',
    });

    // The suite calls from localhost, which is not in the allow list.
    const res = await request.post('/otp/send', {
      data: { phoneNumber: '+919876543210', variables: { otp: '123456' } },
      headers: { 'x-api-key': plaintext },
    });
    expect(
      res.ok(),
      'an IP-restricted key sent from an address outside its allow list',
    ).toBeFalsy();
  });

  test('the key endpoints require authentication', async ({ request }) => {
    expect([401, 403]).toContain((await request.get('/api-keys')).status());
    expect([401, 403]).toContain(
      (await request.post('/api-keys', { data: { label: 'x' } })).status(),
    );
  });

  test('deleting an unknown key 404s rather than 500s', async ({ request }) => {
    const res = await request.delete(
      '/api-keys/00000000-0000-4000-8000-000000000000',
      { headers: auth(customer.accessToken) },
    );
    expect(res.status()).toBeLessThan(500);
  });

  test('a non-uuid key id does not produce a server error', async ({
    request,
  }) => {
    // Same defect class as the refresh cookie: an unvalidated param reaching a
    // uuid column comes back as a cast error, not a 404.
    const res = await request.delete('/api-keys/not-a-uuid', {
      headers: auth(customer.accessToken),
    });
    expect(res.status(), await res.text()).toBeLessThan(500);
  });
});
