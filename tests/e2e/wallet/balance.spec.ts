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
  ABSENT_UUID,
  WELCOME_CREDIT,
  balanceOf,
  errorOf,
  fundWallet,
  ledgerOf,
  listTx,
  mintToken,
  removeWallet,
  walkLedger,
  walletOf,
} from './helpers.js';

/**
 * The customer wallet surface — `GET /wallet` — and the service underneath it.
 *
 * The controller is two lines long; everything worth testing is below it:
 *
 *  - `getWallet` INSERTS when no row exists, so the balance route is a write
 *    dressed as a read, while `findWalletId` on the history route deliberately
 *    is not. The two halves of one controller disagree, and both behaviours
 *    are pinned here so a change to either is visible.
 *
 * wallet/otp-billing covers the shape of the feature and
 * messages/delivery-status covers the status-check route itself. Nothing here
 * repeats either: no happy-path read, no per-message billing. The one
 * deliberate overlap is the missing-header case in the credential loop below —
 * tests/e2e/wallet/otp-billing.spec.ts accepts `[401, 403]` for it, and the
 * point of the loop is that every way of getting a credential wrong lands on
 * the same status *and* the same error code, which needs the baseline case in
 * it to mean anything.
 *
 * Money is asserted exactly. Every figure below is a whole number of paise and
 * comes back out of `numeric(12,4)`, so `toBeCloseTo` would only hide the
 * defect it is meant to catch.
 */

test.describe('wallet edge cases', () => {
  let customer: Customer;

  test.beforeEach(async ({ request }) => {
    await resetDb();
    customer = await createCustomer(request);
    // The wallet controller carries @SkipOnboarding, so this is not needed to
    // reach it — but the debit path runs through /messages, which is gated.
    // The one test that is about the gate makes its own un-onboarded account.
    await onboardCustomer(customer.id);
  });

  test.afterAll(async () => {
    await closeDb();
  });

  test.describe('the balance route', () => {
    test('the balance is unreadable whatever the token is wrong about', async ({
      request,
    }) => {
      // One loop over every way a bearer token can be wrong, because the
      // interesting property is that they are all answered the same way: a
      // different code or status per failure is what lets someone probe which
      // half of a credential is right.
      const expired = mintToken({
        sub: customer.id,
        email: customer.email,
        role: 'customer',
        iat: Math.floor(Date.now() / 1000) - 7200,
        exp: Math.floor(Date.now() / 1000) - 3600,
      });
      const wrongSecret = mintToken(
        { sub: customer.id, email: customer.email, role: 'customer' },
        { secret: process.env.PARTNER_JWT_SECRET ?? 'partner' },
      );

      const attempts: [string, Record<string, string>][] = [
        ['no header at all', {}],
        ['an empty bearer', { Authorization: 'Bearer ' }],
        ['a bare scheme', { Authorization: 'Bearer' }],
        ['not a jwt', { Authorization: 'Bearer not.a.jwt' }],
        // Two extra characters on the signature: the payload still parses, so
        // this only passes if the signature is genuinely verified.
        [
          'a tampered signature',
          { Authorization: `Bearer ${customer.accessToken}xy` },
        ],
        ['an expired token', { Authorization: `Bearer ${expired}` }],
        [
          'the partner realm secret',
          { Authorization: `Bearer ${wrongSecret}` },
        ],
      ];

      for (const [description, headers] of attempts) {
        for (const path of ['/wallet', '/wallet/transactions']) {
          const res = await request.get(path, { headers });
          expect(res.status(), `${path} accepted ${description}`).toBe(401);
          expect((await errorOf(res)).code).toBe('UNAUTHORIZED');
        }
      }
    });

    test('a partner session is not a customer session', async ({ request }) => {
      // Partner tokens are signed with PARTNER_JWT_SECRET and describe a row in
      // `partners`, not in `users`. If one ever authenticated here the wallet
      // service would go looking for a user id that does not exist and write a
      // row against it.
      const partner = await createPartner(request);

      const res = await request.get('/wallet', {
        headers: auth(partner.accessToken),
      });
      expect(res.status(), await res.text()).toBe(401);
      expect((await errorOf(res)).code).toBe('UNAUTHORIZED');

      const [{ count }] = await sql<{ count: string }>(
        `SELECT COUNT(*)::int AS count FROM "wallets" WHERE "userId" = $1`,
        [partner.id],
      );
      expect(Number(count), 'a partner id got a wallet').toBe(0);
    });

    test('a token naming an account that no longer exists cannot conjure a wallet', async ({
      request,
    }) => {
      // A correctly signed token outlives the row it describes — a deleted
      // account keeps a working token for the rest of its 15 minutes. The read
      // path creates a wallet for whoever the token names, so this is the case
      // where that write has no user to hang off.
      const orphan = mintToken({
        sub: ABSENT_UUID,
        email: 'ghost@example.com',
        role: 'customer',
      });

      const res = await request.get('/wallet', { headers: auth(orphan) });

      // Pinned as it behaves, not as it should: today the wallet insert trips
      // the foreign key to "users" and the caller is answered 500 where 401 is
      // the honest reply. What must stay true either way is that no wallet
      // exists for an account that does not.
      expect(
        res.ok(),
        'a wallet was returned for a deleted account',
      ).toBeFalsy();

      const [{ count }] = await sql<{ count: string }>(
        `SELECT COUNT(*)::int AS count FROM "wallets" WHERE "userId" = $1`,
        [ABSENT_UUID],
      );
      expect(Number(count)).toBe(0);
    });

    test('reading the balance writes a wallet row when there is none', async ({
      request,
    }) => {
      // Accounts made outside the registration flow have no wallet — that is
      // what seedCustomer produces, and what every account predating the
      // feature looks like. `getWallet` inserts one on a GET, which is pinned
      // here rather than endorsed: the service's own comment on findWalletId
      // says a read must not write, and this route is the counter-example.
      await removeWallet(customer.id);

      const res = await request.get('/wallet', {
        headers: auth(customer.accessToken),
      });
      expect(res.status(), await res.text()).toBe(200);

      const body = await payload<{
        userId: string;
        balance: string | number;
        currency: string;
      }>(res);
      expect(body.userId).toBe(customer.id);
      expect(Number(body.balance)).toBe(0);
      expect(body.currency).toBe('INR');

      // The row is real, and it is empty. A recreated wallet must never
      // resurrect a balance the ledger cannot account for.
      const wallet = await walletOf(customer.id);
      expect(wallet).not.toBeNull();
      expect(wallet!.balance).toBe(0);
      expect(await ledgerOf(customer.id)).toEqual([]);
    });

    test('two first reads arriving together still leave exactly one wallet', async ({
      request,
    }) => {
      // The read still creates, so two first reads still race — but the
      // insert behind `getWallet` is now ON CONFLICT DO NOTHING followed by a
      // re-read, so the loser reads the winner's row instead of breaking
      // UQ_wallets_userId (InitialSchema line 102) and answering 500 to a GET.
      // A dashboard mounting the balance widget twice was enough to reach it.
      //
      // A pass here is not by itself proof the hole is closed — it may only
      // mean the two requests did not actually overlap — but a failure is the
      // defect coming back, never flakiness. Do not relax this to "at most one
      // 500".
      await removeWallet(customer.id);

      const results = await Promise.all([
        request.get('/wallet', { headers: auth(customer.accessToken) }),
        request.get('/wallet', { headers: auth(customer.accessToken) }),
      ]);

      for (const res of results) {
        expect(
          res.status(),
          `a concurrent first read answered ${res.status()}: ${await res.text()}`,
        ).toBeLessThan(500);
      }

      const [{ count }] = await sql<{ count: string }>(
        `SELECT COUNT(*)::int AS count FROM "wallets" WHERE "userId" = $1`,
        [customer.id],
      );
      expect(Number(count)).toBe(1);
      expect(await balanceOf(customer.id)).toBe(0);
    });

    test('an account still in onboarding can read its balance and nothing else', async ({
      request,
    }) => {
      // @SkipOnboarding on the controller is load-bearing: a customer has to
      // see an empty balance before KYC in order to know to top it up. The
      // second half of this test is what proves the guard is otherwise on —
      // without it, a regression that dropped the decorator would still pass.
      const fresh = await createCustomer(request);

      const wallet = await request.get('/wallet', {
        headers: auth(fresh.accessToken),
      });
      expect(wallet.status(), await wallet.text()).toBe(200);
      expect(Number((await payload<{ balance: string }>(wallet)).balance)).toBe(
        WELCOME_CREDIT,
      );

      const history = await listTx(request, fresh.accessToken);
      expect(history.status(), await history.text()).toBe(200);

      const gated = await request.get('/messages', {
        headers: auth(fresh.accessToken),
      });
      expect(gated.status(), 'the onboarding guard was not in force').toBe(403);
    });

    test('a deactivated account keeps its balance readable by token but not by key', async ({
      request,
    }) => {
      // The two credentials disagree, and the disagreement is pinned because it
      // is a real one: ApiKeyAuthGuard checks isActive, while @SkipOnboarding
      // returns from OnboardingGuard before its deactivation check runs. A
      // suspended account can therefore still read its wallet with a live JWT.
      const created = await request.post('/api-keys', {
        data: { label: 'wallet-read' },
        headers: auth(customer.accessToken),
      });
      expect(created.status(), await created.text()).toBe(201);
      const { key } = await payload<{ key: string }>(created);

      await sql(`UPDATE "users" SET "isActive" = false WHERE "id" = $1`, [
        customer.id,
      ]);

      const byToken = await request.get('/wallet', {
        headers: auth(customer.accessToken),
      });
      expect(byToken.status(), await byToken.text()).toBe(200);

      const byKey = await request.get('/wallet', {
        headers: { 'x-api-key': key },
      });
      expect(byKey.status(), await byKey.text()).toBe(401);
    });

    test('an api key reads the wallet of the account that minted it', async ({
      request,
    }) => {
      // The key populates request.user itself, so @CurrentUser('id') resolves
      // through a different code path than the JWT does. Distinct balances make
      // a mix-up impossible to miss.
      const other = await createCustomer(request);
      await onboardCustomer(other.id);
      await fundWallet(customer.id, 77.5);
      await fundWallet(other.id, 1234);

      const created = await request.post('/api-keys', {
        data: { label: 'owner-check' },
        headers: auth(other.accessToken),
      });
      expect(created.status(), await created.text()).toBe(201);
      const { key } = await payload<{ key: string }>(created);

      const res = await request.get('/wallet', {
        headers: { 'x-api-key': key },
      });
      expect(res.status(), await res.text()).toBe(200);

      const body = await payload<{ userId: string; balance: string }>(res);
      expect(body.userId).toBe(other.id);
      expect(Number(body.balance)).toBe(1234);
    });

    test('the reported balance is the ledger, to the paisa', async ({
      request,
    }) => {
      // 10 + 0.01 + 0.02 is 10.030000000000001 in binary floating point, and
      // the service does that addition in JavaScript. numeric(12,4) is what
      // saves it. A column quietly changed to a float, or a balance served from
      // anywhere other than the row, shows up here as slop.
      const admin = await createAdmin(request);

      for (const amount of [0.01, 0.02]) {
        const res = await request.post('/admin/wallet/topup', {
          data: {
            email: customer.email,
            amount,
            description: `precision top-up of ${amount}`,
          },
          headers: auth(admin.accessToken),
        });
        expect(res.status(), await res.text()).toBe(201);
      }

      const res = await request.get('/wallet', {
        headers: auth(customer.accessToken),
      });
      expect(res.status(), await res.text()).toBe(200);
      expect(Number((await payload<{ balance: string }>(res)).balance)).toBe(
        10.03,
      );

      // And the wallet agrees with its own history, start to finish.
      const rows = await ledgerOf(customer.id);
      expect(rows.length).toBe(3);
      expect(walkLedger(rows, 0)).toBe(10.03);
    });
  });
});
