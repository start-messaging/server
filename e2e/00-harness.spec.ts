import { test, expect } from '@playwright/test';
import { resetDb, closeDb, readSettings, sql } from './helpers/db.js';
import {
  createAdmin,
  createCustomer,
  createPartner,
  auth,
  seedDeliveredMessage,
} from './helpers/actors.js';

/**
 * Proves the harness itself works before any behaviour is asserted on it.
 *
 * If these fail, every later failure is suspect: a green suite built on a
 * broken fixture is worse than no suite.
 */
test.describe('harness', () => {
  test.beforeEach(async () => {
    await resetDb();
  });

  test.afterAll(async () => {
    await closeDb();
  });

  test('is pointed at an isolated database, not the production restore', async () => {
    expect(process.env.DATABASE_NAME).toMatch(/e2e|test/i);

    const [{ count }] = await sql<{ count: string }>(
      `SELECT COUNT(*)::int AS count FROM "users"`,
    );
    expect(Number(count)).toBe(0);
  });

  test('health endpoint is reachable', async ({ request }) => {
    const res = await request.get('/health');
    expect(res.status()).toBe(200);
  });

  test('resetDb restores the settings singleton to shipped defaults', async () => {
    const settings = await readSettings();
    expect(settings.isEnabled).toBe(false);
    expect(Number(settings.accrualIntervalHours)).toBe(48);
    expect(Number(settings.accrualLookbackHours)).toBe(168);
    expect(settings.lastAccrualAt).toBeNull();
  });

  test('creates a customer, an admin and a partner', async ({ request }) => {
    const customer = await createCustomer(request);
    expect(customer.id).toBeTruthy();
    expect(customer.accessToken).toBeTruthy();

    const admin = await createAdmin(request);
    const settingsRes = await request.get('/admin/affiliate/settings', {
      headers: auth(admin.accessToken),
    });
    expect(settingsRes.status(), await settingsRes.text()).toBe(200);

    const partner = await createPartner(request);
    expect(partner.referralCode).toMatch(/^[A-Z0-9]{4,32}$/);

    const me = await request.get('/partner/auth/me', {
      headers: auth(partner.accessToken),
    });
    expect(me.status(), await me.text()).toBe(200);
  });

  test('seeds a delivered message with a controllable updatedAt', async ({
    request,
  }) => {
    const customer = await createCustomer(request);
    const nineDaysAgo = new Date(Date.now() - 9 * 24 * 60 * 60 * 1000);
    const id = await seedDeliveredMessage(customer.id, {
      costAmount: 0.25,
      updatedAt: nineDaysAgo,
    });

    const [row] = await sql<{
      status: string;
      costAmount: string;
      updatedAt: Date;
    }>(`SELECT "status", "costAmount", "updatedAt" FROM "messages" WHERE "id" = $1`, [
      id,
    ]);

    expect(row.status).toBe('delivered');
    expect(Number(row.costAmount)).toBe(0.25);
    expect(new Date(row.updatedAt).getTime()).toBeCloseTo(
      nineDaysAgo.getTime(),
      -3,
    );
  });
});
