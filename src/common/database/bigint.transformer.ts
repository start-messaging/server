import { ValueTransformer } from 'typeorm';

/**
 * TypeORM maps Postgres `bigint` to a JS **string** (to avoid silent precision
 * loss above 2^53). All money in this app is stored as integer **micros**
 * (1 currency unit = 1,000,000 micros). This product's magnitudes (wallet
 * balances, top-ups, per-OTP costs) sit far below 2^53 — e.g. ₹1,00,00,000 is
 * only 1e13 micros — so reading them back as `number` is safe and keeps API
 * payloads numeric. This transformer converts `bigint → number` on read and
 * passes the number straight through on write.
 */
export const bigintTransformer: ValueTransformer = {
  to: (value: number | null | undefined) => value,
  from: (value: string | null): number | null =>
    value === null ? null : Number(value),
};

/** Micros per one whole currency unit (1 unit = 1,000,000 micros). */
export const MICROS_PER_UNIT = 1_000_000;

/** Convert a major-unit (e.g. rupee) amount to integer micros. */
export function toMicros(amount: number): number {
  return Math.round(amount * MICROS_PER_UNIT);
}

/** Convert integer micros back to a major-unit number. */
export function fromMicros(micros: number): number {
  return micros / MICROS_PER_UNIT;
}
