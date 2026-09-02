/**
 * Works out the surcharge added to a top-up.
 *
 * Two modes, because they answer different questions.
 *
 * SIMPLE (default) — add `percent` to what the customer asked for:
 *
 *   request ₹1,000 at 2% → fee ₹20.00, customer pays ₹1,020.00
 *
 *   Round numbers, and trivial to explain on a receipt. It does not recover
 *   the cost exactly: the gateway takes its cut of the ₹1,020 it processes,
 *   not of the ₹1,000 credited, and it charges GST on that cut. At 2% + 18%
 *   GST the merchant nets ₹995.93 on a ₹1,000 credit — around ₹4 short. Set
 *   `percent` to 2.36 to cover the tax as well, or use GROSS_UP to be exact.
 *
 * GROSS_UP — charge whatever nets the requested amount:
 *
 *   charged = amount / (1 - rate)
 *   request ₹1,000 at 2% + 18% GST → fee ₹24.17, customer pays ₹1,024.17
 *   → merchant nets exactly ₹1,000.00
 *
 *   Exact, at the cost of a total nobody can do in their head.
 */

export type ConvenienceFeeMode = 'simple' | 'gross_up';

export interface ConvenienceFeeConfig {
  mode: ConvenienceFeeMode;
  /** The surcharge rate. In SIMPLE mode this is exactly what gets added. */
  percent: number;
  /** Tax the gateway charges on its fee. Only used by GROSS_UP. */
  gstPercent: number;
}

/**
 * The rate in force. Not optional and not switchable: the fee is part of what
 * a top-up costs, so there is no configuration in which it is absent.
 *
 * The values are overridable by environment for the case where the gateway's
 * rate changes and the business needs to follow it without a deploy — but they
 * carry working defaults, so nothing has to be set for this to be correct.
 */
export const DEFAULT_CONVENIENCE_FEE: ConvenienceFeeConfig = {
  mode: 'simple',
  percent: 2,
  gstPercent: 18,
};

export interface FeeBreakdown {
  /** What the wallet is credited. */
  amount: number;
  /** The surcharge added on top. Zero when the fee is absorbed. */
  convenienceFee: number;
  /** What the customer's card is charged. */
  chargedAmount: number;
}

/** Rounds to paise. Money that reaches a gateway must be a whole minor unit. */
function toPaise(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Rounds onto the storage grid: `payments.amount`, `.convenienceFee` and
 * `.chargedAmount` are all numeric(12,4).
 *
 * This matters because `CHK_payments_charged_reconciles` is evaluated against
 * the *stored* values, so arithmetic done at any finer granularity than the
 * column can hold will not agree with what Postgres ends up comparing.
 */
function toStored(value: number): number {
  return Math.round(value * 1e4) / 1e4;
}

export function calculateConvenienceFee(
  rawAmount: number,
  config: ConvenienceFeeConfig,
): FeeBreakdown {
  // Onto the storage grid first, before anything is derived from it.
  //
  // `amount` used to pass through untouched while the fee and the charge were
  // each rounded to paise, so any amount finer than a paisa produced three
  // numbers that did not add up: ₹1000.005 gave a ₹20.00 fee and a ₹1020.01
  // charge, and 1000.005 + 20.00 ≠ 1020.01. `CHK_payments_charged_reconciles`
  // then refused the insert — and createOrder() raises the Razorpay order
  // *before* it saves the row, so the customer got a 500 while a live order sat
  // at the gateway with nothing in our database pointing at it.
  //
  // Rounding here rather than rejecting sub-paise input is deliberate: the
  // columns are numeric(12,4) on purpose and
  // payments/checkout-verification.spec.ts pins that a top-up in fractions of a
  // rupee is credited to the paisa, so the granularity is a feature. Every
  // paise-granular amount — which is every amount the dashboard can produce —
  // is unaffected by this line.
  const amount = toStored(rawAmount);

  // A zero or negative rate is the only way to end up with no surcharge, and
  // it means somebody has configured one deliberately.
  if (config.percent <= 0) {
    return { amount, convenienceFee: 0, chargedAmount: amount };
  }

  if (config.mode === 'simple') {
    const chargedAmount = toPaise(amount + (amount * config.percent) / 100);
    return {
      amount,
      // By subtraction, for the same reason the gross-up branch below does it:
      // the charge has to land on a whole paisa for the gateway, and the fee is
      // then whatever makes the three numbers add up. Rounding the fee
      // independently and adding it back is what broke the identity.
      convenienceFee: toStored(chargedAmount - amount),
      chargedAmount,
    };
  }

  const rate = (config.percent / 100) * (1 + config.gstPercent / 100);

  // A rate at or above 1 has no solution — the fee would consume the whole
  // payment. Configuration is validated well below this, so reaching it means
  // something is badly wrong and absorbing the fee is the safe answer.
  if (rate >= 1) {
    return { amount, convenienceFee: 0, chargedAmount: amount };
  }

  const chargedAmount = toPaise(amount / (1 - rate));

  // Derived by subtraction rather than computed separately, so the three
  // numbers always reconcile exactly no matter how the rounding fell — on the
  // storage grid, which is the grid the CHECK constraint compares on.
  return {
    amount,
    convenienceFee: toStored(chargedAmount - amount),
    chargedAmount,
  };
}
