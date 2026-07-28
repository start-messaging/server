/**
 * The searchable-text expression for a user row.
 *
 * This must stay byte-identical (modulo the table alias) to the expression
 * indexed by IDX_users_search_trgm in migration
 * 1785024000000-PerformanceIndexes. Postgres only uses an expression index
 * when the query's expression matches the index's exactly, so editing this
 * without a matching migration silently turns admin user search back into a
 * full sequential scan.
 *
 * Searching one concatenated expression rather than OR-ing an ILIKE per column
 * is what makes the search indexable at all: a leading-wildcard ILIKE against
 * nine separate columns can never use a btree index, whereas a single GIN
 * trigram index over the concatenation can.
 */
export function buildUserSearchExpression(alias = 'user'): string {
  // The alias MUST be double-quoted. TypeORM's default alias for the User
  // entity is `user`, which is a reserved keyword in Postgres (shorthand for
  // CURRENT_USER) — unquoted, `user."firstName"` is a syntax error.
  const a = `"${alias}"`;
  return `(
  COALESCE(${a}."firstName", '') || ' ' ||
  COALESCE(${a}."lastName", '') || ' ' ||
  COALESCE(${a}."email", '') || ' ' ||
  COALESCE(${a}."mobileNumber", '') || ' ' ||
  COALESCE(${a}."businessName", '') || ' ' ||
  COALESCE(${a}."companyName", '') || ' ' ||
  COALESCE(${a}."websiteUrl", '') || ' ' ||
  COALESCE(${a}."pan", '') || ' ' ||
  COALESCE(${a}."gstin", '')
)`;
}

/** Convenience binding for the conventional `user` alias. */
export const USER_SEARCH_EXPRESSION = buildUserSearchExpression('user');
