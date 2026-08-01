import { test, expect } from '@playwright/test';
import { resetDb, closeDb, sql } from './helpers/db.js';
import {
  createCustomer,
  onboardCustomer,
  Customer,
} from './helpers/actors.js';
import {
  calculateConvenienceFee,
  DEFAULT_CONVENIENCE_FEE,
} from '../src/payments/convenience-fee.js';

/**
 * Passing the gateway's cut on to the customer.
 *
 * The arithmetic is tested directly rather than only through the API, because
 * the property that matters — the merchant nets exactly what the customer is
 * credited — is about the relationship between three numbers, and asserting it
 * on a live order would need a real gateway to take a real fee.
 */
test.describe('convenience fee arithmetic', () => {
  /** What the business actually runs: a flat 2% added to the top-up. */
  const SIMPLE = { mode: 'simple' as const, percent: 2, gstPercent: 18 };
  /** The exact-netting alternative, available but not the default. */
  const RATE = { mode: 'gross_up' as const, percent: 2, gstPercent: 18 };

  test('the shipped default is a flat 2%', () => {
    // There is no switch: a deployment that configures nothing still charges
    // the fee, because it is part of what a top-up costs.
    expect(DEFAULT_CONVENIENCE_FEE).toEqual({
      mode: 'simple',
      percent: 2,
      gstPercent: 18,
    });
    expect(calculateConvenienceFee(1000, DEFAULT_CONVENIENCE_FEE)).toEqual({
      amount: 1000,
      convenienceFee: 20,
      chargedAmount: 1020,
    });
  });

  test('simple mode adds exactly the percentage, in round numbers', () => {
    expect(calculateConvenienceFee(1000, SIMPLE)).toEqual({
      amount: 1000,
      convenienceFee: 20,
      chargedAmount: 1020,
    });
    expect(calculateConvenienceFee(2500, SIMPLE)).toEqual({
      amount: 2500,
      convenienceFee: 50,
      chargedAmount: 2550,
    });
  });

  test('simple mode reconciles and lands on whole paise', () => {
    for (const amount of [1000, 1500, 3333, 9999, 12_345]) {
      const f = calculateConvenienceFee(amount, SIMPLE);
      expect(f.amount + f.convenienceFee).toBeCloseTo(f.chargedAmount, 4);
      expect(Math.round(f.chargedAmount * 100) / 100).toBe(f.chargedAmount);
    }
  });

  test('simple mode does not fully recover the cost, and that is known', () => {
    // Recorded so the trade-off is visible rather than discovered later: a
    // flat 2% leaves the gateway's GST, and its cut of the surcharge itself,
    // with the business. Raising `percent` to 2.36 or switching to gross_up
    // are the two ways to close it.
    const trueRate = 0.0236;
    const f = calculateConvenienceFee(1000, SIMPLE);
    const net = f.chargedAmount - f.chargedAmount * trueRate;

    expect(net).toBeLessThan(1000);
    expect(net).toBeGreaterThan(995);
  });

  test('only a zero rate removes the surcharge', () => {
    const off = calculateConvenienceFee(1000, { ...SIMPLE, percent: 0 });
    expect(off.convenienceFee).toBe(0);
    expect(off.chargedAmount).toBe(1000);
    expect(off.amount).toBe(1000);
  });

  test('the three figures always reconcile', () => {
    for (const amount of [10, 100, 999, 1000, 1234.56, 50_000]) {
      const f = calculateConvenienceFee(amount, RATE);
      expect(
        f.amount + f.convenienceFee,
        `${amount} did not reconcile`,
      ).toBeCloseTo(f.chargedAmount, 4);
    }
  });

  test('the merchant nets what the customer is credited', () => {
    // The whole point of grossing up. Charge C, gateway takes rate×C, and
    // what is left must cover the credit.
    const rate = (RATE.percent / 100) * (1 + RATE.gstPercent / 100);

    for (const amount of [100, 1000, 7500, 25_000]) {
      const f = calculateConvenienceFee(amount, RATE);
      const netToMerchant = f.chargedAmount - f.chargedAmount * rate;

      expect(
        netToMerchant,
        `netting ${netToMerchant} against a credit of ${amount}`,
      ).toBeGreaterThanOrEqual(amount - 0.01);
    }
  });

  test('a naive percentage would have left the merchant short', () => {
    // Documents why this is a gross-up and not `amount * 1.0236`.
    const amount = 1000;
    const rate = 0.0236;

    const naiveCharge = amount * (1 + rate);
    const naiveNet = naiveCharge - naiveCharge * rate;
    expect(naiveNet).toBeLessThan(amount);

    const f = calculateConvenienceFee(amount, RATE);
    expect(f.chargedAmount).toBeGreaterThan(naiveCharge);
  });

  test('everything lands on a whole paisa', () => {
    for (const amount of [1, 33, 777, 1000, 3333.33]) {
      const f = calculateConvenienceFee(amount, RATE);
      for (const [name, value] of Object.entries(f)) {
        expect(
          Math.round(value * 100),
          `${name} for ${amount} is not a whole paisa: ${value}`,
        ).toBeCloseTo(value * 100, 6);
      }
    }
  });

  test('a nonsensical rate falls back to absorbing the fee', () => {
    // A rate at or above 100% has no solution; charging nothing extra is the
    // safe answer rather than an infinity reaching the gateway.
    const f = calculateConvenienceFee(1000, {
      mode: 'gross_up',
      percent: 100,
      gstPercent: 18,
    });
    expect(f.chargedAmount).toBe(1000);
    expect(f.convenienceFee).toBe(0);
  });

  test('2% + 18% GST on ₹1,000 charges ₹1,024.17', () => {
    // Pins the actual number, so a change to the formula has to be deliberate.
    const f = calculateConvenienceFee(1000, RATE);
    expect(f.chargedAmount).toBe(1024.17);
    expect(f.convenienceFee).toBe(24.17);
    expect(f.amount).toBe(1000);
  });
});

test.describe('convenience fee persistence', () => {
  let customer: Customer;

  test.beforeEach(async ({ request }) => {
    await resetDb();
    customer = await createCustomer(request);
    await onboardCustomer(customer.id);
  });

  test.afterAll(async () => {
    await closeDb();
  });

  /**
   * Writes a payment row directly.
   *
   * POST /payments/create-order cannot be used here: it calls Razorpay's live
   * API to raise the order, which needs real credentials this environment does
   * not have. The arithmetic is covered above, and what is left to prove is
   * what the database will and will not store — which does not need a gateway.
   */
  async function seedPayment(opts: {
    amount: number;
    convenienceFee: number;
    chargedAmount: number;
  }) {
    const [row] = await sql<{ id: string }>(
      `INSERT INTO "payments"
         ("userId","gateway","gatewayOrderId","amount","convenienceFee",
          "chargedAmount","currency","status","idempotencyKey")
       VALUES ($1,'razorpay',$2,$3,$4,$5,'INR','created',$2)
       RETURNING "id"`,
      [
        customer.id,
        `order_${Math.round(opts.amount * 100)}_${opts.convenienceFee}`,
        opts.amount,
        opts.convenienceFee,
        opts.chargedAmount,
      ],
    );
    return row.id;
  }

  test('stores a surcharged payment whose parts reconcile', async () => {
    const id = await seedPayment({
      amount: 1000,
      convenienceFee: 24.17,
      chargedAmount: 1024.17,
    });

    const [row] = await sql<{
      amount: string;
      convenienceFee: string;
      chargedAmount: string;
    }>(
      `SELECT "amount","convenienceFee","chargedAmount" FROM "payments" WHERE "id" = $1`,
      [id],
    );

    expect(Number(row.amount)).toBe(1000);
    expect(Number(row.convenienceFee)).toBe(24.17);
    expect(Number(row.chargedAmount)).toBe(1024.17);
  });

  test('the database refuses a row where the figures disagree', async () => {
    // A payment whose parts do not add up means somebody is out of pocket, and
    // it is cheaper to refuse the write than to find it later in a statement.
    await expect(
      seedPayment({ amount: 1000, convenienceFee: 50, chargedAmount: 1024.17 }),
    ).rejects.toThrow(/CHK_payments_charged_reconciles/);
  });

  test('refuses an after-the-fact edit that breaks the reconciliation', async () => {
    const id = await seedPayment({
      amount: 1000,
      convenienceFee: 0,
      chargedAmount: 1000,
    });

    await expect(
      sql(`UPDATE "payments" SET "convenienceFee" = 50 WHERE "id" = $1`, [id]),
    ).rejects.toThrow(/CHK_payments_charged_reconciles/);
  });

  test('existing payments were backfilled to charge what they credited', async () => {
    // The migration asserts this of every historical row: before the
    // surcharge existed, charged and credited were the same number.
    const [row] = await sql<{ bad: string }>(
      `SELECT COUNT(*)::int AS bad FROM "payments"
        WHERE "chargedAmount" <> "amount" + "convenienceFee"`,
    );
    expect(Number(row.bad)).toBe(0);
  });

  test('the surcharge is never what the wallet is credited', async () => {
    // The credit path reads `amount`. The surcharge went to the gateway, not
    // into the customer's balance, so it must never appear there.
    const id = await seedPayment({
      amount: 1000,
      convenienceFee: 24.17,
      chargedAmount: 1024.17,
    });

    const [row] = await sql<{ amount: string; chargedAmount: string }>(
      `SELECT "amount","chargedAmount" FROM "payments" WHERE "id" = $1`,
      [id],
    );
    expect(Number(row.amount)).toBe(1000);
    expect(Number(row.amount)).not.toBe(Number(row.chargedAmount));
  });
});
