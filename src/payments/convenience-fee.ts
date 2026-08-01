/**
 * Works out what to charge a customer so that the merchant nets the top-up.
 *
 * The naive approach — add 2% to the requested amount — does not do that, and
 * the gap is not rounding. The gateway takes its cut of the total it processes,
 * including the surcharge itself:
 *
 *   request ₹1,000, charge ₹1,020, gateway takes 2% of ₹1,020 = ₹20.40
 *   → merchant nets ₹999.60, still 40 paise short of the ₹1,000 credited.
 *
 * Solving for the charge that nets the requested amount is the gross-up:
 *
 *   charged = amount / (1 - rate)
 *
 *   request ₹1,000, charge ₹1,020.41, gateway takes ₹20.41
 *   → merchant nets exactly ₹1,000.
 *
 * `rate` includes GST, because the gateway charges tax on its fee and that is
 * part of what leaves the merchant's account.
 */

export interface ConvenienceFeeConfig {
  enabled: boolean;
  /** Gateway fee, as a percentage of the processed amount. */
  percent: number;
  /** Tax charged on top of that fee, as a percentage of the fee. */
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
