/**
 * Tuning and curated data for the enrichment crawler and its headless-browser
 * escalation tier.
 *
 * These were LEADS_ENRICH_TIMEOUT_MS, LEADS_ENRICH_MAX_ATTEMPTS,
 * LEADS_ENRICH_MAX_PER_RUN, LEADS_PARKED_RECHECK_DAYS,
 * LEADS_BROWSER_TIMEOUT_MS, LEADS_BROWSER_CONCURRENCY and LEADS_PARKING_NS.
 * They describe how crawling behaves, not where this deployment points, and no
 * environment ever wanted a different answer — so an env var for each only
 * meant a stale `.env` on a box could silently disagree with the code.
 *
 * What is deliberately NOT here: the crawler's on/off switch, its batch size,
 * concurrency and re-crawl window. Those are operated from the admin panel
 * (lead_pipeline_settings) because they are tuned while watching a drain run.
 */

/** HTTP fetch timeout for the cheap tier. */
export const ENRICH_TIMEOUT_MS = 10_000;

/** Attempts per lead before it is marked failed. */
export const ENRICH_MAX_ATTEMPTS = 2;

/**
 * Per-run safety valve, deliberately not panel-editable: whatever the panel
 * sets, one drain cannot exceed this many crawls — a recrawl window shorter
 * than the run itself would otherwise keep a drain alive forever.
 */
export const ENRICH_MAX_PER_RUN = 50_000;

/**
 * How stale a parked lead's last check must be before the enrich sweep
 * rechecks it. A parked domain is a business that bought its name and hasn't
 * launched — the weekly recheck catches the launch moment.
 */
export const PARKED_RECHECK_DAYS = 7;

/** Page-render timeout for the headless tier, which is slower by design. */
export const BROWSER_TIMEOUT_MS = 20_000;

/** One page at a time — this tier trades speed for reach. */
export const BROWSER_CONCURRENCY = 1;

/**
 * Parking-service nameserver suffixes: a domain whose NS ends with one of
 * these is parked at the registrar, whatever its page says. DNS is the cheap,
 * hard-to-fool detector — Hostinger's parking is literally ns1.dns-parking.com
 * — so the enrichment checks NS before ever fetching.
 *
 * CSV rather than an array so readers keep going through `parseCsvList`, which
 * lowercases, strips leading dots and de-duplicates — the normalisation the
 * suffix matching assumes.
 */
export const PARKING_NS_CSV =
  'dns-parking.com,sedoparking.com,parkingcrew.net,bodis.com,above.com,' +
  'afternic.com,dan.com,uniregistry.com';
