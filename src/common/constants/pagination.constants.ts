/** Page size used when a client does not ask for one. */
export const DEFAULT_PAGE_SIZE = 20;

/** Hard ceiling on rows per page, enforced by validation. */
export const MAX_PAGE_SIZE = 100;

/**
 * Hard ceiling on `OFFSET`.
 *
 * Offset pagination degrades linearly with depth: `OFFSET 500000` makes
 * Postgres walk and discard half a million index entries before returning a
 * single row. Nobody browses that deep by hand — requests that far in are
 * either scrapers or a client looping to export data, and both should use the
 * cursor API instead. Refusing past this point keeps one client from pinning a
 * database core.
 */
export const MAX_OFFSET = 50_000;

/**
 * Row ceiling for a bounded count.
 *
 * `SELECT count(*)` over a large filtered set has to visit every matching row.
 * A bounded count stops at this many and reports "at least N", which is enough
 * to drive a pager while staying O(1) in the worst case.
 */
export const COUNT_CEILING = 10_000;

/** Sentinel total returned when the client opted out of counting. */
export const COUNT_SKIPPED = -1;
