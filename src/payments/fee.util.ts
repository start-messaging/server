/**
 * Customer-fee-bearer math. When the user bears the fee they pay the gateway's
 * platform fee (a % of the base top-up) plus GST on that fee, on top of the
 * base amount. Only the base is credited to the wallet. All values are integer
 * micros.
 */
export interface FeeBreakdown {
  baseMicros: number;
  convenienceFeeMicros: number;
  gstMicros: number;
  totalMicros: number;
}

export interface FeeConfig {
  feePercent: number;
  gstPercent: number;
  bearer: string; // 'customer' | 'platform'
}

export function computeConvenienceFee(
  baseMicros: number,
  cfg: FeeConfig,
): FeeBreakdown {
  if (cfg.bearer !== 'customer') {
    return {
      baseMicros,
      convenienceFeeMicros: 0,
      gstMicros: 0,
      totalMicros: baseMicros,
    };
  }
  const convenienceFeeMicros = Math.round((baseMicros * cfg.feePercent) / 100);
  const gstMicros = Math.round((convenienceFeeMicros * cfg.gstPercent) / 100);
  const totalMicros = baseMicros + convenienceFeeMicros + gstMicros;
  return { baseMicros, convenienceFeeMicros, gstMicros, totalMicros };
}

/** Micros → paise (Razorpay's smallest unit for INR). 1 paisa = 10,000 micros. */
export function microsToPaise(micros: number): number {
  return Math.round(micros / 10_000);
}

/** Paise → micros. */
export function paiseToMicros(paise: number): number {
  return paise * 10_000;
}
