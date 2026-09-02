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
import { errorCode, read, removeFixtures } from './helpers.js';

/**
 * Reaching the channel and template catalogue: GET /channels,
 * GET /channels/:id/templates and GET /templates.
 *
 * ChannelsController is declared `@Controller()` with no prefix, so these three
 * sit at the API root beside /auth and /otp rather than under a namespace of
 * their own. Two things make them unlike every other customer route:
 *
 *  - they carry `@SkipOnboarding()`, so the guard that normally stands between
 *    a fresh account and the API steps aside — and with it the deactivation
 *    check that lives in the same guard;
 *  - they carry no `@Roles`, so any authenticated caller reads the same list.
 */

test.describe('channel and template catalogue', () => {
  let admin: Customer;
  let customer: Customer;
  let smsChannelId: string;

  test.beforeEach(async ({ request }) => {
    await resetDb();
    // Belt and braces: if a previous run died mid-test its rows are still
    // here, and `channels` is not something resetDb truncates.
    await removeFixtures();

    admin = await createAdmin(request);
    customer = await createCustomer(request);
    await onboardCustomer(customer.id);

    const [row] = await sql<{ id: string }>(
      `SELECT "id" FROM "channels" WHERE "name" = 'sms'`,
    );
    // Seeded by onModuleInit on every boot. Its absence means the server under
    // test never finished starting, and every assertion below would be noise.
    expect(row?.id, 'the sms channel was not seeded at boot').toBeTruthy();
    smsChannelId = row.id;
  });

  test.afterEach(async () => {
    await removeFixtures();
  });

  test.afterAll(async () => {
    await closeDb();
  });

  test.describe('reaching it', () => {
    test('all three catalogue routes refuse an anonymous caller', async ({
      request,
    }) => {
      for (const path of [
        '/channels',
        '/templates',
        `/channels/${smsChannelId}/templates`,
      ]) {
        const res = await request.get(path);
        expect(res.status(), `${path}: ${await res.text()}`).toBe(401);
        expect(await errorCode(res)).toBe('UNAUTHORIZED');
      }
    });

    // A bearer-token forgery matrix used to live here — alg:none, a rewritten
    // signature, real signature over rewritten claims. It was removed rather
    // than kept: CombinedAuthGuard is an APP_GUARD, so the code path it
    // exercises is not specific to this controller, and
    // auth/sessions.spec.ts already pins exactly those cases (`editing
    // the claims inside a real token does not grant them` and `a token signed
    // with another secret, or with no algorithm at all, is refused`), with the
    // same 401/UNAUTHORIZED. Two copies of one assertion is one copy that gets
    // weakened when it breaks.

    test('a partner session cannot read the customer catalogue', async ({
      request,
    }) => {
      // Partner tokens are minted with PARTNER_JWT_SECRET and their own
      // audience, so they are structurally incapable of authenticating a
      // customer route — this asserts that separation has not been softened
      // into a shared secret.
      const partner = await createPartner(request);

      for (const path of [
        '/channels',
        '/templates',
        `/channels/${smsChannelId}/templates`,
      ]) {
        const res = await request.get(path, {
          headers: auth(partner.accessToken),
        });
        expect(res.status(), `${path} accepted a partner token`).toBe(401);
        expect(await errorCode(res)).toBe('UNAUTHORIZED');
      }
    });

    test('an admin sees exactly the catalogue a customer sees', async ({
      request,
    }) => {
      // No @Roles on the controller, which is deliberate — the admin panel
      // reads the same list for its dropdowns. What would be a defect is the
      // two diverging, so they are compared rather than merely both allowed.
      for (const path of ['/channels', '/templates']) {
        const asCustomer = await read<unknown[]>(
          request,
          customer.accessToken,
          path,
        );
        const asAdmin = await read<unknown[]>(request, admin.accessToken, path);
        expect(asAdmin, `${path} differed by role`).toEqual(asCustomer);
      }
    });

    test('a customer who has not finished onboarding can still read the catalogue', async ({
      request,
    }) => {
      // The signup wizard shows the template list before KYC is approved, which
      // is why the controller is @SkipOnboarding. The contrast route proves the
      // account really is un-onboarded rather than the guard being off
      // everywhere.
      const fresh = await createCustomer(request);

      const gated = await request.get('/api-keys', {
        headers: auth(fresh.accessToken),
      });
      expect(gated.status(), 'the fixture was already onboarded').toBe(403);

      for (const path of [
        '/channels',
        '/templates',
        `/channels/${smsChannelId}/templates`,
      ]) {
        const res = await request.get(path, {
          headers: auth(fresh.accessToken),
        });
        expect(res.status(), `${path}: ${await res.text()}`).toBe(200);
      }
    });

    test('an API key reads the catalogue, and a bogus key does not', async ({
      request,
    }) => {
      // Machine clients pick a templateId from this list before calling
      // /otp/send, and they only ever hold an API key — CombinedAuthGuard
      // falling back to the key path is what makes that possible.
      const created = await request.post('/api-keys', {
        data: { label: 'e2e-channels' },
        headers: auth(customer.accessToken),
      });
      expect(created.ok(), await created.text()).toBeTruthy();
      // ApiKeysService.create returns the plaintext under `key`, once.
      const { key: plaintext } = await payload<{ key: string }>(created);
      expect(plaintext, 'the key was not returned at creation').toBeTruthy();

      const res = await request.get('/templates', {
        headers: { 'x-api-key': plaintext },
      });
      expect(res.status(), await res.text()).toBe(200);

      const bogus = await request.get('/templates', {
        headers: { 'x-api-key': `${plaintext}x` },
      });
      expect(bogus.status(), 'a mutated API key was accepted').toBe(401);
      expect(await errorCode(bogus)).toBe('UNAUTHORIZED');
    });

    test('a deactivated account keeps catalogue access on its JWT but loses it on its API key', async ({
      request,
    }) => {
      // Current behaviour, pinned rather than endorsed. The only isActive check
      // on the customer JWT path lives in OnboardingGuard, and this controller
      // opts out of that guard entirely — so a deactivated user's access token
      // still reads the catalogue until it expires. The API-key path checks the
      // owner separately in ApiKeyAuthGuard and does cut them off. The
      // catalogue is public product copy, so the leak is small; the asymmetry
      // is the thing worth knowing about.
      const created = await request.post('/api-keys', {
        data: { label: 'e2e-deactivated' },
        headers: auth(customer.accessToken),
      });
      expect(created.ok(), await created.text()).toBeTruthy();
      const { key: plaintext } = await payload<{ key: string }>(created);

      await sql(`UPDATE "users" SET "isActive" = false WHERE "id" = $1`, [
        customer.id,
      ]);

      const viaJwt = await request.get('/channels', {
        headers: auth(customer.accessToken),
      });
      expect(viaJwt.status(), await viaJwt.text()).toBe(200);

      const viaKey = await request.get('/channels', {
        headers: { 'x-api-key': plaintext },
      });
      expect(
        viaKey.status(),
        'a deactivated account authenticated by key',
      ).toBe(401);

      // And a route that does run OnboardingGuard still bites immediately.
      const gated = await request.get('/api-keys', {
        headers: auth(customer.accessToken),
      });
      expect(
        gated.status(),
        'deactivation did not bite on a guarded route',
      ).toBe(403);
    });

    test('the catalogue routes are read-only', async ({ request }) => {
      // Only @Get handlers are registered, so any write verb must fall through
      // to the router's 404 rather than reaching a handler.
      const [{ count: before }] = await sql<{ count: string }>(
        `SELECT COUNT(*)::int AS count FROM "channels"`,
      );

      for (const path of ['/channels', '/templates']) {
        for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
          const res = await request.fetch(path, {
            method,
            data: {},
            headers: auth(customer.accessToken),
          });
          expect(res.status(), `${method} ${path} was routed somewhere`).toBe(
            404,
          );
          expect(await errorCode(res)).toBe('NOT_FOUND');
        }
      }

      const [{ count: after }] = await sql<{ count: string }>(
        `SELECT COUNT(*)::int AS count FROM "channels"`,
      );
      expect(Number(after)).toBe(Number(before));
    });
  });
});
