/** Where a lead row came from. */
export enum LeadSource {
  /** The daily newly-registered-domains ingest. */
  NRD = 'nrd',
  /** Typed in by an admin. */
  MANUAL = 'manual',
}

/**
 * Where the conversation with this prospect stands.
 *
 * Enrichment progress is deliberately a separate column — "no email found" is
 * a fact about the website, not about where the conversation stands. Folding
 * the two into one status would make "crawl failed" overwrite "they replied",
 * and neither fact should be able to destroy the other.
 */
export enum LeadStatus {
  NEW = 'new',
  QUEUED = 'queued',
  CONTACTED = 'contacted',
  REPLIED = 'replied',
  CONVERTED = 'converted',
  UNSUBSCRIBED = 'unsubscribed',
  BOUNCED = 'bounced',
  /**
   * Delisted from targeting by the team (the panel's "delist" button PATCHes
   * this). Every automated sweep — liveness probe, enrichment claim, parked
   * recheck — skips disqualified leads: the team said stop spending on this
   * one. Reversible: PATCH back to 'new' re-lists it.
   */
  DISQUALIFIED = 'disqualified',
}

/**
 * Whether a website answers for this domain at all — the cheap tier-0 gate
 * in front of the crawler. Owned by the liveness prober alone; the crawler
 * and the team never write it (the same one-column-per-stage rule that keeps
 * status and enrichmentStatus from destroying each other).
 *
 * There is deliberately no terminal "dead": a day-old NRD domain that is not
 * live today is a business that has not launched yet, so INACTIVE is a wait
 * state with a re-probe clock (daily for young domains, then weekly, then
 * monthly — see the prober's claim query), never a verdict.
 */
export enum LeadLiveness {
  /** Never probed. */
  UNKNOWN = 'unknown',
  /** The site answered — the enrichment crawler may spend on it. */
  LIVE = 'live',
  /** No DNS or no HTTP answer at last probe; re-probed on the backoff. */
  INACTIVE = 'inactive',
}

/** What the crawler has established about the lead's website. */
export enum LeadEnrichmentStatus {
  PENDING = 'pending',
  ENRICHED = 'enriched',
  /** The site was reachable but exposed no contact route. */
  NO_CONTACT = 'no_contact',
  /**
   * The domain sits on a registrar parking service (parking NS, or a parked
   * page). Not dead — a business bought this name and hasn't launched, so
   * the enrich sweep rechecks parked leads weekly to catch the launch.
   * Nothing found on a parked page is stored: the contacts and "fit" a
   * parked template shows belong to the REGISTRAR, not the prospect.
   */
  PARKED = 'parked',
  FAILED = 'failed',
}

/** One thing that happened to one outreach email. */
export enum LeadOutreachEventType {
  QUEUED = 'queued',
  SENT = 'sent',
  OPENED = 'opened',
  CLICKED = 'clicked',
  REPLIED = 'replied',
  BOUNCED = 'bounced',
  UNSUBSCRIBED = 'unsubscribed',
  FAILED = 'failed',
}

/** Why an address must never be mailed again. */
export enum SuppressionReason {
  UNSUBSCRIBED = 'unsubscribed',
  BOUNCED = 'bounced',
  COMPLAINT = 'complaint',
  MANUAL = 'manual',
}

/** Lifecycle of one day's NRD file ingest. */
export enum LeadIngestRunStatus {
  PENDING = 'pending',
  COMPLETED = 'completed',
  FAILED = 'failed',
}
