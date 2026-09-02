/**
 * Parked-domain detection for the enrichment crawler.
 *
 * Exists because parked domains (Hostinger et al.) were scoring high fit off
 * the REGISTRAR's template page — its login form, its payment links, its
 * contact address. A parked domain is a future prospect, not a dead one: the
 * business bought its name and hasn't launched, so the sweep rechecks parked
 * leads weekly instead of burying them.
 *
 * Pure and I/O-free like nrd-filter.ts (the enum import is a value-less
 * constant), so both detectors are unit-testable: the NS path in particular
 * cannot be exercised end-to-end without real DNS (the e2e fixture domains
 * are deliberately unregistered), so the unit tests here are its only
 * coverage.
 */

import { LeadEnrichmentStatus } from '../enums/lead.enum.js';

/**
 * Case-insensitive suffix match of a nameserver host against the configured
 * parking-service list (leads.parkingNs). Suffix, not substring: matching on
 * '.dns-parking.com' catches ns1/ns2/… while 'notdns-parking.com.evil.tld'
 * stays out. DNS is the cheap, hard-to-fool detector — Hostinger's parking
 * is literally ns1.dns-parking.com — which is why the enrichment checks NS
 * before ever fetching the page.
 */
export function nsIndicatesParking(
  nameservers: string[],
  parkingSuffixes: string[],
): boolean {
  const suffixes = parkingSuffixes
    .map((s) => s.trim().toLowerCase().replace(/^\.+/, ''))
    .filter(Boolean);
  return nameservers.some((ns) => {
    const host = ns.trim().toLowerCase().replace(/\.$/, '');
    return suffixes.some(
      (suffix) => host === suffix || host.endsWith(`.${suffix}`),
    );
  });
}

/**
 * Phrases that only parking/for-sale templates render. The HTML fallback for
 * parking services that use ordinary nameservers (or when the NS lookup
 * failed): unlike the qualification signals this IS a text match, because
 * the fact being checked — "this page says the domain is parked" — is
 * literally a sentence.
 */
const PARKED_PAGE_SIGNATURES = [
  'domain is parked',
  'parked domain',
  'this domain is for sale',
  'buy this domain',
  'domain may be for sale',
  'hugedomains',
];

/** True when the fetched page matches a parked/for-sale template signature. */
export function htmlIndicatesParking(html: string): boolean {
  const lower = html.toLowerCase();
  return PARKED_PAGE_SIGNATURES.some((sig) => lower.includes(sig));
}

/** The lead fields a parked verdict writes. Structural, so both writers —
 * the enrichment crawler and the liveness prober — share one definition. */
export interface ParkedWritableLead {
  enrichmentStatus: LeadEnrichmentStatus;
  contactEmails: string[];
  contactPhones: string[];
  contactWhatsapp: string[];
  qualificationScore: number;
  qualificationSignals: string[];
  siteTitle: string | null;
  siteDescription: string | null;
  enrichedAt: Date | null;
  enrichmentError: string | null;
}

/**
 * Applies a parked verdict to a lead in memory (the caller saves).
 *
 * Everything a parked page shows belongs to the REGISTRAR, not the
 * prospect: contacts are not stored and the qualification is zeroed — the
 * old word-scan scored Hostinger's template as a hot lead. What IS kept:
 * siteTitle/description of the page that was seen (`seen` is null on the
 * DNS path, which never fetched one), and isIndian/indiaSignals untouched —
 * a parking template says nothing about the business's country. enrichedAt
 * is the recheck clock: the sweep re-crawls parked leads weekly, because a
 * parked domain is a business that bought its name and hasn't launched —
 * the recheck catches the launch moment.
 */
export function applyParkedVerdict(
  lead: ParkedWritableLead,
  seen: { title: string | null; description: string | null } | null,
): void {
  lead.enrichmentStatus = LeadEnrichmentStatus.PARKED;
  lead.contactEmails = [];
  lead.contactPhones = [];
  lead.contactWhatsapp = [];
  lead.qualificationScore = 0;
  lead.qualificationSignals = [];
  if (seen) {
    lead.siteTitle = seen.title ?? lead.siteTitle;
    lead.siteDescription = seen.description ?? lead.siteDescription;
  }
  lead.enrichedAt = new Date();
  lead.enrichmentError = null;
}
