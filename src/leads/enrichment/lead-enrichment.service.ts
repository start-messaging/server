import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { resolveMx, resolveNs } from 'dns/promises';

import { ErrorCodes } from '../../common/constants/error-codes.constant.js';
import { Lead } from '../entities/lead.entity.js';
import { LeadEnrichmentStatus } from '../enums/lead.enum.js';
import { parseCsvList } from '../nrd/nrd-filter.js';
import { INDIA_TOKENS_CSV } from '../nrd/tld-lists.constant.js';
import {
  ExtractedContacts,
  extractContacts,
  indiaHintFromSignals,
  mergeExtractions,
  scoreSignals,
} from './contact-extractor.js';
import {
  applyParkedVerdict,
  htmlIndicatesParking,
  nsIndicatesParking,
} from './parked-detector.js';
import {
  ENRICH_MAX_ATTEMPTS,
  ENRICH_TIMEOUT_MS,
  PARKING_NS_CSV,
} from './enrich-tuning.constant.js';

/** Hard cap on how much of a response body we will read. */
const BODY_CAP_BYTES = 512 * 1024;

/**
 * Identifies the crawler honestly. A day-old domain's owner seeing this in
 * their access log can find out who fetched their page and why. Exported so
 * the browser tier presents the same identity — rendering the page instead of
 * fetching it changes our cost, not who we are.
 */
export const CRAWLER_UA =
  'Mozilla/5.0 (compatible; StartMessagingBot/1.0; +https://startmessaging.com)';

/**
 * Reads a response body up to a byte cap and stops.
 *
 * Streamed rather than res.text() because a parked domain serving a 50 MB
 * blob must cost us nothing: the cap cancels the stream, so neither memory
 * nor bandwidth follows the size of what a stranger's server decides to send.
 */
async function readBodyCapped(
  response: Response,
  capBytes: number,
): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return '';

  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (total + value.byteLength > capBytes) {
      chunks.push(value.subarray(0, capBytes - total));
      await reader.cancel();
      break;
    }
    chunks.push(value);
    total += value.byteLength;
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Order-preserving union, capped like every contact jsonb column. Shared with
 * the browser tier: BOTH tiers persist by merging into what the row already
 * holds, so re-running either one can only ever add.
 */
export function unionCapped(existing: string[], added: string[]): string[] {
  return [...new Set([...existing, ...added])].slice(0, 10);
}

@Injectable()
export class LeadEnrichmentService {
  private readonly logger = new Logger(LeadEnrichmentService.name);

  constructor(
    @InjectRepository(Lead)
    private readonly leads: Repository<Lead>,
    private readonly config: ConfigService,
  ) {}

  private get timeoutMs(): number {
    return ENRICH_TIMEOUT_MS;
  }

  private get maxAttempts(): number {
    return ENRICH_MAX_ATTEMPTS;
  }

  /**
   * The configured LEADS_INDIA_TOKENS list, shared with the ingest filter.
   * Threaded into the pure extractor as a parameter — the city-name weak
   * signal needs it, and the extractor itself never reads config.
   */
  private get indiaTokens(): string[] {
    return [...parseCsvList(INDIA_TOKENS_CSV)];
  }

  /**
   * Crawls one lead's site and records what it found.
   *
   * Used by both the queue worker and the synchronous admin endpoint, so it
   * NEVER throws for network reasons: an unreachable site is a result — the
   * failure lands in enrichmentStatus/enrichmentError and the lead comes back
   * to the caller either way. Only a missing lead is an actual error.
   */
  async enrichLead(leadId: string): Promise<Lead> {
    const lead = await this.leads.findOne({ where: { id: leadId } });
    if (!lead) {
      throw new NotFoundException({
        code: ErrorCodes.NOT_FOUND,
        message: 'Lead not found',
      });
    }

    lead.enrichmentAttempts += 1;

    try {
      // Parked check, DNS first: a domain whose nameservers sit on a parking
      // service is parked whatever its page says — Hostinger's parking is
      // literally ns1.dns-parking.com — and DNS is cheaper and harder to
      // fool than HTML, so a parking NS means we never fetch the page at
      // all. A failed lookup is an empty answer, never a parked verdict.
      // The liveness prober runs the same check at probe time; it stays here
      // too because the weekly parked RECHECK and the synchronous admin
      // enrich both enter without a fresh probe, and one NS lookup is cheap.
      const parkingSuffixes = [...parseCsvList(PARKING_NS_CSV)];
      const nameservers = await resolveNs(lead.domain).catch(
        () => [] as string[],
      );
      if (nsIndicatesParking(nameservers, parkingSuffixes)) {
        return this.persistParked(lead, null);
      }

      const baseUrl = (
        this.config.get<string>('leads.enrich.urlTemplate') ??
        'https://{domain}'
      ).replace('{domain}', lead.domain);

      const landingHtml = await this.fetchPage(baseUrl);

      // Parked check, HTML fallback: parking services that use ordinary
      // nameservers still render a template that says so. The title and
      // description of what was seen are kept for context; everything else
      // on that page belongs to the registrar.
      if (htmlIndicatesParking(landingHtml)) {
        return this.persistParked(
          lead,
          extractContacts(landingHtml, this.indiaTokens),
        );
      }

      let extracted = extractContacts(landingHtml, this.indiaTokens);

      // No address on the landing page: follow up to TWO more same-site
      // pages — followPaths orders contact pages before about pages — and
      // stop the moment an email shows up. Three requests total is the
      // budget; this runs against thousands of strangers' sites, and the
      // third-best page is not worth a fourth request.
      for (const path of extracted.followPaths.slice(0, 2)) {
        if (extracted.emails.length > 0) break;
        try {
          const followUrl = new URL(path, baseUrl).toString();
          const followPage = await this.fetchAndExtract(followUrl);
          extracted = mergeExtractions(extracted, followPage);
        } catch {
          // The landing page already succeeded; a broken link must not turn
          // the whole enrichment into a failure.
        }
      }

      const hasMx = await resolveMx(lead.domain)
        .then((records) => records.length > 0)
        .catch(() => false);

      // UNION with what any earlier run stored, never replacement — the same
      // merge the browser tier uses. This replaced a plain overwrite, which
      // meant a tier-1 re-run after a browser enrich wiped the contacts only
      // the rendered DOM had, downgraded the lead to no_contact, and — with
      // browserAttemptedAt already claimed — nothing could ever escalate it
      // back. A crawl can only ever add to a lead now.
      lead.contactEmails = unionCapped(lead.contactEmails, extracted.emails);
      lead.contactPhones = unionCapped(lead.contactPhones, extracted.phones);
      lead.contactWhatsapp = unionCapped(
        lead.contactWhatsapp,
        extracted.whatsapp,
      );
      // Freshest title/description win when the crawl saw one; a crawl that
      // saw none keeps what an earlier run stored.
      lead.siteTitle = extracted.title ?? lead.siteTitle;
      lead.siteDescription = extracted.description ?? lead.siteDescription;
      lead.hasMx = hasMx;

      const signals = [
        ...new Set([...lead.qualificationSignals, ...extracted.signals]),
      ];
      lead.qualificationSignals = signals;
      lead.qualificationScore = scoreSignals(signals);

      // Recorded even when the hint threshold is not met: a single weak
      // signal does not flip isIndian, but the team can still see it.
      const indiaSignals = [
        ...new Set([...lead.indiaSignals, ...extracted.indiaSignals]),
      ];
      lead.indiaSignals = indiaSignals;

      // Only ever upgrade null → true, re-derived over the union. Ingest set
      // true for Indian TLDs and India-named domains by construction; a
      // crawl that finds no India signal is absence of evidence, not
      // evidence the business left India.
      if (lead.isIndian == null && indiaHintFromSignals(indiaSignals)) {
        lead.isIndian = true;
      }

      const foundContact =
        lead.contactEmails.length > 0 ||
        lead.contactPhones.length > 0 ||
        lead.contactWhatsapp.length > 0;
      if (foundContact) {
        lead.enrichmentStatus = LeadEnrichmentStatus.ENRICHED;
      } else if (lead.enrichmentStatus !== LeadEnrichmentStatus.ENRICHED) {
        // Never downgrade: this run seeing nothing does not unsee what an
        // earlier one found.
        lead.enrichmentStatus = LeadEnrichmentStatus.NO_CONTACT;
      }
      lead.enrichedAt = new Date();
      lead.enrichmentError = null;
    } catch (err) {
      const message = (err as Error).message ?? 'unknown error';
      const hadResult =
        lead.enrichmentStatus === LeadEnrichmentStatus.ENRICHED ||
        lead.enrichmentStatus === LeadEnrichmentStatus.NO_CONTACT ||
        lead.enrichmentStatus === LeadEnrichmentStatus.PARKED;
      if (hadResult) {
        // A failed RE-crawl (the recrawl cycle, a parked recheck, or an
        // admin re-run) must not destroy an established result: the site
        // erroring today does not unsee what an earlier crawl found, so the
        // status stands and only the error is recorded. enrichedAt still
        // advances — it is the "last crawled" clock the recrawl cycle
        // claims by, and without the bump the drain would re-claim the same
        // erroring lead every slice forever; this way it simply comes back
        // next window.
        lead.enrichedAt = new Date();
        lead.enrichmentError = message.slice(0, 2000);
      } else {
        // First-crawl path, unchanged: pending → a later drain retries;
        // failed → the retry budget is spent and the lead exits the pool.
        lead.enrichmentStatus =
          lead.enrichmentAttempts >= this.maxAttempts
            ? LeadEnrichmentStatus.FAILED
            : LeadEnrichmentStatus.PENDING;
        lead.enrichmentError = message.slice(0, 2000);
      }
      this.logger.warn(`Enrichment of ${lead.domain} failed: ${message}`);
    }

    return this.leads.save(lead);
  }

  /**
   * Records a parked verdict — the shared applier holds the semantics (see
   * applyParkedVerdict in parked-detector.ts: registrar junk discarded,
   * title/description kept, isIndian untouched, enrichedAt = recheck clock).
   * The liveness prober parks through the same applier, so a probe-time and
   * a crawl-time parked verdict are indistinguishable in the row.
   */
  private persistParked(
    lead: Lead,
    seen: ExtractedContacts | null,
  ): Promise<Lead> {
    applyParkedVerdict(lead, seen);
    return this.leads.save(lead);
  }

  /** One capped, identified fetch; non-2xx is a thrown result. */
  private async fetchPage(url: string): Promise<string> {
    const response = await fetch(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(this.timeoutMs),
      headers: { 'User-Agent': CRAWLER_UA },
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} from ${url}`);
    }
    return readBodyCapped(response, BODY_CAP_BYTES);
  }

  private async fetchAndExtract(url: string): Promise<ExtractedContacts> {
    return extractContacts(await this.fetchPage(url), this.indiaTokens);
  }
}
