import { test, expect, APIResponse } from '@playwright/test';
import { resetDb, closeDb, sql } from '../helpers/db.js';
import {
  createAdmin,
  createCustomer,
  createPartner,
  onboardCustomer,
  payload,
  unique,
  Customer,
} from '../helpers/actors.js';
import {
  NOWHERE,
  WELCOME_CREDIT,
  balanceOf,
  errorCode,
  removeFixtures,
  topup,
} from './ops-helpers.js';

/**
 * Manual wallet credits — the one path in the system that creates money with no
 * payment behind it.
 *
 * admin/overview.spec.ts walks the happy path of this route. This file goes after
 * the seams instead — the amount with a slipped decimal, the address that
 * belongs to nobody, and the second click on a button that moves money.
 */

test.describe('admin ops — manual wallet credits', () => {
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

  test('a credit lands exactly, and is attributable to the admin who made it', async ({
    request,
  }) => {
    // This is the one path in the system that creates money with no payment
    // behind it, so the reference has to name the admin who did it.
    const res = await request.post(
      '/admin/wallet/topup',
      topup(
        {
          email: customer.email,
          amount: 250.5,
          description: 'Goodwill credit for failed sends',
          internalNote: 'ticket #412',
        },
        admin.accessToken,
      ),
    );
    expect(res.status(), await res.text()).toBe(201);

    const body = await payload<{
      amount: number;
      balanceBefore: number;
      balanceAfter: number;
      user: { id: string };
    }>(res);
    expect(body.user.id).toBe(customer.id);
    expect(body.amount).toBe(250.5);
    expect(body.balanceBefore).toBe(WELCOME_CREDIT);
    expect(body.balanceAfter).toBe(260.5);

    expect(await balanceOf(customer.id)).toBe(260.5);

    const [tx] = await sql<{
      type: string;
      amount: string;
      balanceBefore: string;
      balanceAfter: string;
      referenceType: string;
      referenceId: string;
      description: string;
    }>(
      `SELECT wt."type", wt."amount", wt."balanceBefore", wt."balanceAfter",
              wt."referenceType", wt."referenceId", wt."description"
         FROM "wallet_transactions" wt
         JOIN "wallets" w ON w."id" = wt."walletId"
        WHERE w."userId" = $1 AND wt."referenceType" = 'admin_topup'`,
      [customer.id],
    );
    expect(tx.type).toBe('credit');
    expect(Number(tx.amount)).toBe(250.5);
    expect(Number(tx.balanceBefore)).toBe(WELCOME_CREDIT);
    expect(Number(tx.balanceAfter)).toBe(260.5);
    expect(tx.referenceId).toBe(`${admin.id} | ticket #412`);
    expect(tx.description).toBe('Goodwill credit for failed sends');
  });

  test('an amount outside the accepted band never moves the wallet', async ({
    request,
  }) => {
    // The band is @Min(0.01) to @Max(100000) with at most four decimal places:
    // a floor above zero because a zero credit is a ledger entry that means
    // nothing, and a ceiling because this is hand-typed with no second approval.
    const before = await balanceOf(customer.id);

    for (const amount of [
      0,
      -1,
      -0.01,
      0.009, // under the floor
      0.00001, // more precision than numeric(12,4) can hold
      100000.01, // one paisa over the ceiling
      1e12,
      Number.MAX_SAFE_INTEGER,
      'abc',
      null,
      [500], // an array where a scalar is expected
    ]) {
      const res = await request.post(
        '/admin/wallet/topup',
        topup(
          {
            email: customer.email,
            amount,
            description: 'should never land',
          },
          admin.accessToken,
        ),
      );
      expect(
        res.status(),
        `amount ${JSON.stringify(amount)} was accepted`,
      ).toBe(400);
      expect(await errorCode(res)).toBe('VALIDATION_ERROR');
    }

    expect(await balanceOf(customer.id)).toBe(before);
    const [{ count }] = await sql<{ count: string }>(
      `SELECT COUNT(*)::int AS count FROM "wallet_transactions" WHERE "referenceType" = 'admin_topup'`,
    );
    expect(Number(count)).toBe(0);
  });

  test('the boundaries themselves are accepted', async ({ request }) => {
    // One paisa and the ceiling exactly. Off-by-one on a @Min/@Max is invisible
    // until the day support needs to credit a round ₹100000.
    const floor = await request.post(
      '/admin/wallet/topup',
      topup(
        { email: customer.email, amount: 0.01, description: 'floor case' },
        admin.accessToken,
      ),
    );
    expect(floor.status(), await floor.text()).toBe(201);

    const ceiling = await request.post(
      '/admin/wallet/topup',
      topup(
        { email: customer.email, amount: 100000, description: 'ceiling case' },
        admin.accessToken,
      ),
    );
    expect(ceiling.status(), await ceiling.text()).toBe(201);

    expect(await balanceOf(customer.id)).toBe(100010.01);
  });

  test('a numeric string and a boolean are coerced into money rather than refused', async ({
    request,
  }) => {
    // The global ValidationPipe runs with enableImplicitConversion, so the body
    // is cast to the DTO's reflected types before class-validator sees it:
    // "500" becomes 500, and `true` becomes 1. Pinned as it behaves today —
    // the string is defensible, the boolean crediting one rupee is not.
    const asString = await request.post(
      '/admin/wallet/topup',
      topup(
        { email: customer.email, amount: '500', description: 'string amount' },
        admin.accessToken,
      ),
    );
    expect(asString.status(), await asString.text()).toBe(201);
    expect(await balanceOf(customer.id)).toBe(510);

    const asBoolean = await request.post(
      '/admin/wallet/topup',
      topup(
        { email: customer.email, amount: true, description: 'boolean amount' },
        admin.accessToken,
      ),
    );
    expect(asBoolean.status(), await asBoolean.text()).toBe(201);
    expect(
      await balanceOf(customer.id),
      'a JSON boolean was worth a rupee',
    ).toBe(511);
  });

  test('a description that says nothing is refused, and one with unicode survives intact', async ({
    request,
  }) => {
    // The description is shown to the customer in their own transaction
    // history, so it is required, bounded, and must come back byte for byte.
    for (const description of [
      undefined,
      null,
      '',
      'ab',
      'x'.repeat(201),
      12345,
    ]) {
      const res = await request.post(
        '/admin/wallet/topup',
        topup(
          { email: customer.email, amount: 5, description },
          admin.accessToken,
        ),
      );
      if (description === 12345) {
        // Implicit conversion turns a number into the string "12345", which is
        // long enough to pass. Not a defect worth failing over, but pinned so
        // the coercion is visible.
        expect(res.status(), await res.text()).toBe(201);
        continue;
      }
      expect(
        res.status(),
        `description ${JSON.stringify(description)} was accepted`,
      ).toBe(400);
    }

    const unicode = 'Credit • ₹5 goodwill — डिलीवरी विफल 🙏';
    const ok = await request.post(
      '/admin/wallet/topup',
      topup(
        { email: customer.email, amount: 5, description: unicode },
        admin.accessToken,
      ),
    );
    expect(ok.status(), await ok.text()).toBe(201);

    // Ordered by balance rather than by time: the numeric-description case
    // above also landed, and two credits made a millisecond apart are not a
    // reliable tiebreak.
    const [row] = await sql<{ description: string }>(
      `SELECT wt."description"
         FROM "wallet_transactions" wt
         JOIN "wallets" w ON w."id" = wt."walletId"
        WHERE w."userId" = $1
        ORDER BY wt."balanceAfter" DESC LIMIT 1`,
      [customer.id],
    );
    expect(row.description).toBe(unicode);
  });

  test('crediting an address nobody owns is a 404 and creates nothing', async ({
    request,
  }) => {
    const walletsBefore = await sql<{ count: string }>(
      `SELECT COUNT(*)::int AS count FROM "wallets"`,
    );
    const partner = await createPartner(request);

    // A partner is not a customer: partners live in their own table and have no
    // wallet here, so their address must not resolve to anything.
    for (const email of [`${unique('ghost')}@example.com`, partner.email]) {
      const res = await request.post(
        '/admin/wallet/topup',
        topup(
          { email, amount: 100, description: 'to nobody' },
          admin.accessToken,
        ),
      );
      expect(res.status(), `${email} resolved to a wallet`).toBe(404);
      expect(await errorCode(res)).toBe('NOT_FOUND');
    }

    const walletsAfter = await sql<{ count: string }>(
      `SELECT COUNT(*)::int AS count FROM "wallets"`,
    );
    expect(Number(walletsAfter[0].count)).toBe(Number(walletsBefore[0].count));
  });

  test('a malformed address is refused before any lookup happens', async ({
    request,
  }) => {
    // The leading/trailing-space case is the one that matters in practice: an
    // address pasted out of a support ticket usually carries whitespace, and
    // silently trimming it would mean the credit lands on an address the admin
    // did not actually type.
    for (const email of [
      undefined,
      null,
      '',
      'not-an-email',
      ' spaced@example.com ',
      'two@@example.com',
      123,
    ]) {
      const res = await request.post(
        '/admin/wallet/topup',
        topup(
          { email, amount: 100, description: 'bad address' },
          admin.accessToken,
        ),
      );
      expect(res.status(), `email ${JSON.stringify(email)} was accepted`).toBe(
        400,
      );
    }
  });

  test('the address is matched case-insensitively, so a paste cannot create a second wallet', async ({
    request,
  }) => {
    const res = await request.post(
      '/admin/wallet/topup',
      topup(
        {
          email: customer.email.toUpperCase(),
          amount: 40,
          description: 'shouted address',
        },
        admin.accessToken,
      ),
    );
    expect(res.status(), await res.text()).toBe(201);

    expect(await balanceOf(customer.id)).toBe(50);
    const [{ count }] = await sql<{ count: string }>(
      `SELECT COUNT(*)::int AS count FROM "wallets" WHERE "userId" = $1`,
      [customer.id],
    );
    expect(Number(count)).toBe(1);
  });

  test('fields the DTO does not declare cannot steer the credit', async ({
    request,
  }) => {
    // The pipe whitelists but does not forbid unknown properties, so extras are
    // stripped silently. What matters is that none of them reach the ledger:
    // no chosen balance, no forged reference type, no crediting a third party.
    const bystander = await createCustomer(request);
    const bystanderBefore = await balanceOf(bystander.id);

    const res = await request.post(
      '/admin/wallet/topup',
      topup(
        {
          email: customer.email,
          amount: 5,
          description: 'extras attached',
          userId: bystander.id,
          balanceAfter: 999999,
          referenceType: 'payment',
          type: 'debit',
          id: NOWHERE,
        },
        admin.accessToken,
      ),
    );
    expect(res.status(), await res.text()).toBe(201);

    expect(await balanceOf(customer.id)).toBe(15);
    expect(await balanceOf(bystander.id)).toBe(bystanderBefore);

    const [tx] = await sql<{
      id: string;
      type: string;
      referenceType: string;
      balanceAfter: string;
    }>(
      `SELECT wt."id", wt."type", wt."referenceType", wt."balanceAfter"
         FROM "wallet_transactions" wt
         JOIN "wallets" w ON w."id" = wt."walletId"
        WHERE w."userId" = $1 AND wt."referenceType" = 'admin_topup'`,
      [customer.id],
    );
    expect(tx.type).toBe('credit');
    expect(tx.referenceType).toBe('admin_topup');
    expect(Number(tx.balanceAfter)).toBe(15);
    expect(tx.id).not.toBe(NOWHERE);
  });

  test('submitting the same credit twice credits twice', async ({
    request,
  }) => {
    // There is no idempotency key on this DTO, so a double-clicked support form
    // creates the money twice. Pinned as it behaves today — see the note in the
    // return payload; the fix belongs in src, not here.
    const body = {
      email: customer.email,
      amount: 100,
      description: 'double submit',
    };

    const first = await request.post(
      '/admin/wallet/topup',
      topup(body, admin.accessToken),
    );
    const second = await request.post(
      '/admin/wallet/topup',
      topup(body, admin.accessToken),
    );

    expect(first.status(), await first.text()).toBe(201);
    expect(second.status(), await second.text()).toBe(201);
    expect(
      await balanceOf(customer.id),
      'a repeated identical credit was deduplicated somewhere',
    ).toBe(210);

    const [{ count }] = await sql<{ count: string }>(
      `SELECT COUNT(*)::int AS count
         FROM "wallet_transactions" wt
         JOIN "wallets" w ON w."id" = wt."walletId"
        WHERE w."userId" = $1 AND wt."referenceType" = 'admin_topup'`,
      [customer.id],
    );
    expect(Number(count)).toBe(2);
  });

  test('two simultaneous credits both land and neither overwrites the other', async ({
    request,
  }) => {
    // The credit reads the wallet FOR UPDATE inside a transaction. Without that
    // lock both requests read ₹10, both write ₹110, and one credit vanishes
    // while still being reported as successful. The chain of balanceBefore ->
    // balanceAfter across the two rows is what proves the lock held.
    const body = {
      email: customer.email,
      amount: 100,
      description: 'concurrent credit',
    };

    const [a, b] = await Promise.all([
      request.post('/admin/wallet/topup', topup(body, admin.accessToken)),
      request.post('/admin/wallet/topup', topup(body, admin.accessToken)),
    ]);
    expect(a.status(), await a.text()).toBe(201);
    expect(b.status(), await b.text()).toBe(201);

    expect(await balanceOf(customer.id)).toBe(210);

    const rows = await sql<{ balanceBefore: string; balanceAfter: string }>(
      `SELECT wt."balanceBefore", wt."balanceAfter"
         FROM "wallet_transactions" wt
         JOIN "wallets" w ON w."id" = wt."walletId"
        WHERE w."userId" = $1 AND wt."referenceType" = 'admin_topup'
        ORDER BY wt."balanceAfter" ASC`,
      [customer.id],
    );
    expect(rows.length).toBe(2);
    expect(Number(rows[0].balanceBefore)).toBe(10);
    expect(Number(rows[0].balanceAfter)).toBe(110);
    expect(Number(rows[1].balanceBefore)).toBe(110);
    expect(Number(rows[1].balanceAfter)).toBe(210);
  });

  test('repeated fractional credits stay exact in the ledger', async ({
    request,
  }) => {
    // The running balance is added up in JavaScript: 10.2 + 0.1 is
    // 10.299999999999999 there, and numeric(12,4) is what makes the stored
    // figure exact. wallet/balance.spec.ts already pins that stored side;
    // what is asserted here is the *response*, whose balanceAfter is the raw
    // JavaScript sum rather than the column. A panel rendering
    // 10.299999999999999 next to a statement saying 10.30 is a support ticket.
    let last: APIResponse | null = null;
    for (let i = 0; i < 3; i += 1) {
      last = await request.post(
        '/admin/wallet/topup',
        topup(
          { email: customer.email, amount: 0.1, description: `slice ${i}` },
          admin.accessToken,
        ),
      );
      expect(last.status(), await last.text()).toBe(201);
    }

    expect(await balanceOf(customer.id)).toBe(10.3);

    const [tx] = await sql<{ balanceAfter: string }>(
      `SELECT wt."balanceAfter"
         FROM "wallet_transactions" wt
         JOIN "wallets" w ON w."id" = wt."walletId"
        WHERE w."userId" = $1 AND wt."referenceType" = 'admin_topup'
        ORDER BY wt."balanceAfter" DESC LIMIT 1`,
      [customer.id],
    );
    expect(Number(tx.balanceAfter)).toBe(10.3);

    const body = await payload<{ balanceAfter: number }>(last!);
    expect(Number(body.balanceAfter.toFixed(4))).toBe(10.3);
  });

  test('an admin can credit their own wallet', async ({ request }) => {
    // findByEmail has no role filter, so "customer" in the route description is
    // aspirational: an admin can name themselves and mint their own balance
    // with no second approval. Pinned as it behaves today; flagged in the
    // return payload as a governance gap rather than a crash.
    const res = await request.post(
      '/admin/wallet/topup',
      topup(
        { email: admin.email, amount: 5000, description: 'self credit' },
        admin.accessToken,
      ),
    );
    expect(res.status(), await res.text()).toBe(201);
    expect(await balanceOf(admin.id)).toBe(5010);
  });
});
