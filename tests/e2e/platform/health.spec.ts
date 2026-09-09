import { test, expect } from '@playwright/test';
import { resetDb, closeDb } from '../helpers/db.js';
import { payload } from '../helpers/actors.js';

/**
 * `/health` — one of the two routes nobody has to authenticate to reach. The
 * other is the 2Factor delivery report callback (`/webhooks/2factor`, POST and
 * GET), pinned in tests/e2e/webhooks/delivery-reports.spec.ts.
 */

test.describe('health endpoint edge cases', () => {
  test.beforeEach(async () => {
    await resetDb();
  });

  test.afterAll(async () => {
    await closeDb();
  });

  test('health needs no credential and ignores any that is offered', async ({
    request,
  }) => {
    // The load balancer polls this with no headers at all. If the guard ever
    // stopped short-circuiting on @Public — or started rejecting a stale token
    // a proxy happened to forward — the whole fleet would be pulled out of
    // rotation by its own health check.
    const anonymous = await request.get('/health');
    const forged = await request.get('/health', {
      headers: { Authorization: 'Bearer not.a.jwt' },
    });
    const expired = await request.get('/health', {
      headers: {
        Authorization:
          'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.' +
          'eyJzdWIiOiIwMDAwMDAwMC0wMDAwLTQwMDAtODAwMC0wMDAwMDAwMDAwMDAiLCJleHAiOjF9.' +
          'ZmFrZXNpZ25hdHVyZQ',
      },
    });
    const apiKey = await request.get('/health', {
      headers: { 'X-API-Key': 'sk_live_definitely_not_a_real_key' },
    });

    for (const res of [anonymous, forged, expired, apiKey]) {
      expect(res.status(), await res.text()).toBe(200);
      expect(await payload<{ status: string }>(res)).toEqual(
        await payload(anonymous),
      );
    }
  });

  test('health reports the database up without naming it', async ({
    request,
  }) => {
    const res = await request.get('/health');
    expect(res.status(), await res.text()).toBe(200);

    const body = await payload<{
      status: string;
      info: Record<string, unknown>;
      error: Record<string, unknown>;
      details: Record<string, unknown>;
    }>(res);

    expect(body.status).toBe('ok');
    // Exactly the terminus envelope and nothing bolted on: an indicator that
    // starts reporting a version, a host or an uptime is a free reconnaissance
    // feed on an endpoint that is anonymous by design.
    expect(Object.keys(body).sort()).toEqual([
      'details',
      'error',
      'info',
      'status',
    ]);
    expect(body.info.database).toEqual({ status: 'up' });
    expect(body.error).toEqual({});

    const text = await res.text();
    const secrets = [
      process.env.DATABASE_PASSWORD,
      process.env.DATABASE_NAME,
      process.env.DATABASE_USERNAME,
      process.env.DATABASE_HOST,
      process.env.REDIS_URL,
      process.env.JWT_SECRET,
      process.env.PARTNER_JWT_SECRET,
      process.env.RAZORPAY_KEY_SECRET,
    ].filter((v): v is string => !!v && v.length >= 4);
    expect(secrets.length, 'no environment to check against').toBeGreaterThan(
      0,
    );
    for (const secret of secrets) {
      expect(text, `the health response echoed "${secret}"`).not.toContain(
        secret,
      );
    }

    // helmet is applied globally; the banner it removes is the cheapest
    // fingerprint of the stack an anonymous caller can collect.
    expect(res.headers()['x-powered-by']).toBeUndefined();
    expect(res.headers()['x-content-type-options']).toBe('nosniff');
  });

  test('health does not answer verbs it does not implement', async ({
    request,
  }) => {
    for (const res of [
      await request.post('/health', { data: {} }),
      await request.delete('/health'),
    ]) {
      expect(res.status(), await res.text()).toBe(404);
      const body = (await res.json()) as {
        error: { code: string; message: string };
      };
      expect(body.error.code).toBe('NOT_FOUND');
    }
  });
});
