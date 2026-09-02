/**
 * Tuning for the tier-0 liveness prober.
 *
 * These were LEADS_LIVENESS_BATCH_PER_SWEEP, LEADS_LIVENESS_CONCURRENCY and
 * LEADS_LIVENESS_TIMEOUT_MS. They are here because no environment ever wanted
 * a different answer: they describe how a DNS answer and a header round-trip
 * behave, not where this deployment points. An env var for each only spread
 * the numbers across four files and let a stale `.env` disagree with the code.
 *
 * The prober's on/off switch is deliberately NOT here — it is operated from
 * the admin panel (lead_pipeline_settings.livenessEnabled), because that is a
 * decision someone makes at 2am, not one worth a deploy.
 */

/**
 * Leads claimed per sweep. Hourly sweeps × this batch must exceed the daily
 * intake plus re-probes, or the backlog grows faster than it clears.
 */
export const LIVENESS_BATCH_PER_SWEEP = 8000;

/**
 * In-process probe pool. 25 is safe where the crawler's 4 is not: a probe is
 * one DNS answer and one header round-trip, not a page render.
 */
export const LIVENESS_CONCURRENCY = 25;

/** A live site answers headers well inside this; a hang IS "inactive". */
export const LIVENESS_TIMEOUT_MS = 4_000;
