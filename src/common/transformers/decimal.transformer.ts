import { ValueTransformer } from 'typeorm';

/**
 * Makes a Postgres `numeric` column read back as a JavaScript number.
 *
 * node-postgres returns `numeric` as a *string*, deliberately — the type is
 * arbitrary-precision and a double cannot represent all of it. TypeORM passes
 * that string straight through, so a column declared `amount: number` actually
 * holds `"30.0000"` at run time. The declared type is a lie, and the failure it
 * invites is silent: `a.amount + b.amount` concatenates instead of adding, and
 * `a.amount > b.amount` compares lexicographically, so "9" > "10" is true.
 *
 * Every call site in this codebase currently defends itself with an explicit
 * `Number()`. This removes the need for that rather than adding to it — the
 * consuming TypeScript already declares these fields as `number`, including
 * the partner portal's own types, so this makes reality match what everything
 * already assumes.
 *
 * SCOPE: applied only to the affiliate money columns. The wallet, payment and
 * message entities have the same latent problem and should be converted too,
 * but in their own change — they are on the deployed billing path, and
 * bundling them here would mean one commit that alters the JSON shape of both
 * the affiliate API and live billing at once.
 *
 * PRECISION: these columns are numeric(12,4) — at most 12 significant digits,
 * so the largest representable value is under 10^8 rupees with 4 decimal
 * places. That is far inside Number.MAX_SAFE_INTEGER (~9×10^15), so the
 * conversion is exact for every value the column can hold. Money arithmetic
 * that must be exact is still done in Postgres, not here: the accrual and
 * payout services compute in SQL precisely so rounding happens in `numeric`.
 */
export const DecimalTransformer: ValueTransformer = {
  /**
   * Going to the database. Numbers are passed through untouched — TypeORM
   * serialises them correctly for a numeric column — and null/undefined are
   * preserved so a nullable column (`partners.commissionRate`) can still be
   * cleared, which is how a per-partner rate override is removed.
   */
  to(value: number | null | undefined): number | null | undefined {
    return value;
  },

  /** Coming back out. `null` stays `null` rather than becoming 0. */
  from(value: string | null): number | null {
    if (value === null || value === undefined) return null;
    return typeof value === 'number' ? value : Number(value);
  },
};
