import { IsInt, IsOptional, Max, Min } from 'class-validator';
import { Transform } from 'class-transformer';
import { ApiPropertyOptional } from '@nestjs/swagger';

/** Window used when `days` is absent or unusable: one week of daily buckets. */
export const DEFAULT_TRENDS_DAYS = 7;

/**
 * Widest trends window: 366 days — a full year of daily buckets, leap day
 * included, which is the longest range the dashboard graph offers. Past a year
 * a daily series stops being readable as a line and the answer people actually
 * want is a monthly rollup, so a wider window is a client bug rather than a
 * request worth serving.
 *
 * The bound is not cosmetic. `istDayStart(days)` shifts a Date by `days` and a
 * JS Date only spans ±100,000,000 days; `?days=1000000000` pushed it past that,
 * produced an Invalid Date, and pg serialised it to the literal
 * "0NaN-NaN-NaNTNaN:NaN:NaN.NaN+NaN:NaN" — Postgres rejected it and the
 * QueryFailedError surfaced as a 500. A query parameter must never be able to
 * fault the server.
 */
export const MAX_TRENDS_DAYS = 366;

/**
 * Coerces `days` and keeps the historical fallback behaviour.
 *
 * Reads the raw value off the source object rather than the transformed one,
 * because the global ValidationPipe runs with `enableImplicitConversion: true`
 * and would already have turned `''` into `0`.
 *
 * Unlike the paginated endpoints, a junk value here is defaulted rather than
 * rejected: `days` used to be a bare `@Query('days')` defaulted with `|| 7`, so
 * `?days=abc`, `?days=0` and `?days=` have always answered 200 with a week of
 * data, and the dashboard relies on that. What reaches the validators below —
 * and so becomes a 400 — is anything that parses to a real number the endpoint
 * cannot serve: outside ±366, or not a whole number. `?days=1.5` used to coerce
 * to 1.5 and answer 200; nothing pins that, and a fractional day has no bucket.
 */
const TrendsDays = () =>
  Transform(({ obj, key }: { obj: Record<string, unknown>; key: string }) => {
    const raw = obj?.[key];
    const missing =
      raw === undefined ||
      raw === null ||
      (typeof raw === 'string' && raw.trim() === '');
    if (missing) return DEFAULT_TRENDS_DAYS;

    const parsed = Number(raw);
    // NaN (`?days=abc`, or the array a repeated `?days=` produces) and 0 are
    // what `|| 7` used to swallow.
    return !Number.isFinite(parsed) || parsed === 0
      ? DEFAULT_TRENDS_DAYS
      : parsed;
  });

export class DashboardTrendsQueryDto {
  /**
   * Negative values stay legal, hence the symmetric lower bound. A negative
   * shift moves the window start into the future so the response is an empty
   * series — pinned by e2e, because the dangerous reading of a negative window
   * would be "unbounded" and dumping the caller's whole history. Bounding it at
   * -366 keeps the Date arithmetic representable, which is the actual defect.
   */
  @ApiPropertyOptional({
    default: DEFAULT_TRENDS_DAYS,
    minimum: -MAX_TRENDS_DAYS,
    maximum: MAX_TRENDS_DAYS,
    description:
      'Number of past days to chart. Unusable values fall back to a week.',
  })
  @IsOptional()
  @TrendsDays()
  @IsInt()
  @Min(-MAX_TRENDS_DAYS)
  @Max(MAX_TRENDS_DAYS)
  days: number = DEFAULT_TRENDS_DAYS;
}
