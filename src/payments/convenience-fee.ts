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
  enabled: boolean;
  mode: ConvenienceFeeMode;
  /** The surcharge rate. In SIMPLE mode this is exactly what gets added. */
  percent: number;
  /** Tax the gateway charges on its fee. Only used by GROSS_UP. */
  gstPercent: number;
}

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

export function calculateConvenienceFee(
  amount: number,
  config: ConvenienceFeeConfig,
): FeeBreakdown {
  if (!config.enabled || config.percent <= 0) {
    return { amount, convenienceFee: 0, chargedAmount: amount };
  }

  if (config.mode === 'simple') {
    const convenienceFee = toPaise((amount * config.percent) / 100);
    return {
      amount,
      convenienceFee,
      chargedAmount: toPaise(amount + convenienceFee),
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
  // numbers always reconcile exactly no matter how the rounding fell.
  return {
    amount,
    convenienceFee: toPaise(chargedAmount - amount),
    chargedAmount,
  };
}
