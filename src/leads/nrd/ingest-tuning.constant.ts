/**
 * Tuning for the daily NRD ingest.
 *
 * This was LEADS_INGEST_MAX_INSERTS. The source URL stays an env var
 * (LEADS_NRD_URL_TEMPLATE) because the e2e suite genuinely repoints it at a
 * fixture server and a future mirror should need no code change — but the cap
 * below is a property of the pipeline, not of the environment.
 */

/**
 * Backstop against a poisoned or mis-parsed file flooding the table — NOT a
 * curation tool: the ingest priority-sorts (India first, score desc) before
 * cutting, so a cap cut only ever discards the lowest-value tail. With
 * ingest-all, ~100–150k generic-TLD keeps/day is the new normal, hence 200k:
 * a healthy day fits whole.
 */
export const INGEST_MAX_INSERTS = 200_000;
