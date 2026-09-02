import { test, expect, APIRequestContext } from '@playwright/test';
import { resetDb, closeDb, sql } from '../helpers/db.js';
import {
  createAdmin,
  createCustomer,
  onboardCustomer,
  createPartner,
  auth,
  payload,
  Customer,
} from '../helpers/actors.js';
// A local `credit()` used to live in this file. It took a target rather than
// an amount, so `credit(customer.id, 0)` wrote a *debit* of ten — a function
// that credited nothing at two of its call sites. fundWallet says what it does.
import { fundWallet } from './helpers.js';

/**
 * Wallet, OTP send and the billing that connects them.
 *
 * This is the live product's money path — a customer's prepaid balance is
 * debited per delivered OTP — so the invariants here matter more than anything
 * in the affiliate module: the affiliate ledger is derived from it.
 */
test.describe('wallet and OTP billing', () => {
  let customer: Customer;

  test.beforeEach(async ({ request }) => {
    await resetDb();
    customer = await createCustomer(request);
    // OTP send sits behind OnboardingGuard; these tests are about billing.
    await onboardCustomer(customer.id);
  });

  test.afterAll(async () => {
    await closeDb();
  });

  async function walletRow(userId: string) {
    const [row] = await sql<{ id: string; balance: string }>(
      `SELECT w."id", w."balance" FROM "wallets" w WHERE w."userId" = $1`,
      [userId],
    );
    return row ?? null;
  }

  /** The OTP itself lives in a nested `variables` object, not at the top level. */
  function sendOtp(
    request: APIRequestContext,
    token: string,
    body: { phoneNumber?: string; otp?: string } = {},
  ) {
    return request.post('/otp/send', {
      data: {
        phoneNumber: body.phoneNumber ?? '+919876543210',
        variables: { otp: body.otp ?? '123456' },
      },
      headers: auth(token),
    });
  }

  test('a new customer has a wallet readable through the API', async ({
    request,
  }) => {
    const res = await request.get('/wallet', { headers: auth(customer.accessToken) });
    expect(res.ok(), await res.text()).toBeTruthy();

    const body = await payload<{ balance: number | string }>(res);
    expect(Number(body.balance)).toBeGreaterThanOrEqual(0);
  });

  test('the wallet is not readable without a token', async ({ request }) => {
    const res = await request.get('/wallet');
    expect([401, 403]).toContain(res.status());
  });

  test('one customer cannot read another customer wallet', async ({
    request,
  }) => {
    const other = await createCustomer(request);
    await fundWallet(other.id, 5000);

    const res = await request.get('/wallet', { headers: auth(customer.accessToken) });
    const body = await payload<{ userId?: string; balance: number | string }>(res);

    if (body.userId) expect(body.userId).toBe(customer.id);
    expect(Number(body.balance)).not.toBe(5000);
  });

  test('sending an OTP debits the wallet by the message cost', async ({
    request,
  }) => {
    await fundWallet(customer.id, 100);

    const res = await sendOtp(request, customer.accessToken);
    expect(res.ok(), await res.text()).toBeTruthy();

    const after = await walletRow(customer.id);
    const [message] = await sql<{ costAmount: string; status: string }>(
      `SELECT "costAmount", "status" FROM "messages" WHERE "userId" = $1`,
      [customer.id],
    );

    expect(message).toBeTruthy();
    // Whatever the tariff, the debit must equal what the message was charged.
    expect(Number(after.balance)).toBeCloseTo(100 - Number(message.costAmount), 4);
  });

  test('an insufficient balance is refused and charges nothing', async ({
    request,
  }) => {
    await fundWallet(customer.id, 0);

    const res = await sendOtp(request, customer.accessToken);
    expect(res.ok()).toBeFalsy();

    const after = await walletRow(customer.id);
    expect(Number(after?.balance ?? 0)).toBe(0);

    const [{ count }] = await sql<{ count: string }>(
      `SELECT COUNT(*)::int AS count FROM "messages" WHERE "userId" = $1`,
      [customer.id],
    );
    expect(Number(count)).toBe(0);
  });

  test('the wallet balance never goes negative under repeated sends', async ({
    request,
  }) => {
    // Enough for a couple of messages, then deliberately overdrawn.
    await fundWallet(customer.id, 0.6);

    for (let i = 0; i < 6; i += 1) {
      await sendOtp(request, customer.accessToken);
    }

    const after = await walletRow(customer.id);
    expect(Number(after.balance)).toBeGreaterThanOrEqual(0);
  });

  test('every debit is recorded as a wallet transaction that reconciles', async ({
    request,
  }) => {
    await fundWallet(customer.id, 100);
    const sent = await sendOtp(request, customer.accessToken);
    expect(sent.ok(), await sent.text()).toBeTruthy();

    const rows = await sql<{
      type: string;
      amount: string;
      balanceBefore: string;
      balanceAfter: string;
    }>(
      `SELECT t."type", t."amount", t."balanceBefore", t."balanceAfter"
         FROM "wallet_transactions" t
         JOIN "wallets" w ON w."id" = t."walletId"
        WHERE w."userId" = $1
        ORDER BY t."createdAt"`,
      [customer.id],
    );
    expect(rows.length).toBeGreaterThanOrEqual(1);

    for (const row of rows) {
      const before = Number(row.balanceBefore);
      const after = Number(row.balanceAfter);
      const amount = Number(row.amount);
      const expected = row.type === 'debit' ? before - amount : before + amount;
      expect(after, `${row.type} of ${amount} from ${before}`).toBeCloseTo(
        expected,
        4,
      );
    }

    // The ledger's final balance is the wallet's balance.
    const wallet = await walletRow(customer.id);
    expect(Number(rows[rows.length - 1].balanceAfter)).toBeCloseTo(
      Number(wallet.balance),
      4,
    );
  });

  test('an invalid phone number is rejected before anything is charged', async ({
    request,
  }) => {
    await fundWallet(customer.id, 100);

    for (const phoneNumber of ['12345', '+1555000111', '+919876', 'abc', '']) {
      const res = await sendOtp(request, customer.accessToken, { phoneNumber });
      expect(res.status(), `accepted ${phoneNumber}`).toBe(400);
    }

    expect(Number((await walletRow(customer.id)).balance)).toBe(100);
  });

  test('an invalid OTP code is rejected', async ({ request }) => {
    await fundWallet(customer.id, 100);

    for (const otp of ['12', '1234567', 'abcdef', '']) {
      const res = await sendOtp(request, customer.accessToken, { otp });
      expect(res.status(), `accepted otp ${otp}`).toBe(400);
    }
  });

  test('OTP send requires authentication', async ({ request }) => {
    const res = await request.post('/otp/send', {
      data: { phoneNumber: '+919876543210', variables: { otp: '123456' } },
    });
    expect([401, 403]).toContain(res.status());
  });

  test('transactions are scoped to the caller', async ({ request }) => {
    await fundWallet(customer.id, 100);
    await sendOtp(request, customer.accessToken);

    const other = await createCustomer(request);
    await onboardCustomer(other.id);
    const res = await request.get('/wallet/transactions', {
      headers: auth(other.accessToken),
    });
    expect(res.ok(), await res.text()).toBeTruthy();

    // Not "zero rows": a fresh account can legitimately have its own opening
    // entries. What matters is that none of them are this customer's.
    const rows = await payload<{ walletId?: string }[]>(res);
    const [mine] = await sql<{ id: string }>(
      `SELECT "id" FROM "wallets" WHERE "userId" = $1`,
      [customer.id],
    );
    for (const row of rows) {
      if (row.walletId) expect(row.walletId).not.toBe(mine.id);
    }
    const [{ count }] = await sql<{ count: string }>(
      `SELECT COUNT(*)::int AS count FROM "wallet_transactions" t
         JOIN "wallets" w ON w."id" = t."walletId"
        WHERE w."userId" = $1 AND t."type" = 'debit'`,
      [other.id],
    );
    expect(Number(count)).toBe(0);
  });

  test('a partner token cannot spend a customer wallet', async ({ request }) => {
    const partner = await createPartner(request);
    await fundWallet(customer.id, 100);

    const res = await sendOtp(request, partner.accessToken);
    expect([401, 403]).toContain(res.status());

    expect(Number((await walletRow(customer.id)).balance)).toBe(100);
  });

  test('the affiliate ledger never exceeds what the customer was billed', async ({
    request,
  }) => {
    // Commission is a share of message cost, so total commission on a message
    // must never exceed the message's own cost.
    const admin = await createAdmin(request);
    const partner = await createPartner(request);
    await request.patch('/admin/affiliate/settings', {
      data: { isEnabled: true },
      headers: auth(admin.accessToken),
    });

    await sql(
      `INSERT INTO "referrals" ("partnerId", "userId", "referralCode", "status")
       VALUES ($1, $2, $3, 'pending')`,
      [partner.id, customer.id, partner.referralCode],
    );

    await fundWallet(customer.id, 100);
    await sendOtp(request, customer.accessToken);
    await request.post('/admin/affiliate/jobs/accrual', {
      headers: auth(admin.accessToken),
    });

    const [totals] = await sql<{ billed: string; commission: string }>(
      `SELECT
         COALESCE((SELECT SUM("costAmount") FROM "messages" WHERE "userId" = $1), 0) AS billed,
         COALESCE((SELECT SUM("amount") FROM "partner_commissions" WHERE "userId" = $1), 0) AS commission`,
      [customer.id],
    );

    expect(Number(totals.commission)).toBeLessThanOrEqual(Number(totals.billed));
  });
});
