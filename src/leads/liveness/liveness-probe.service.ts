import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { resolveNs } from 'dns/promises';

import { ErrorCodes } from '../../common/constants/error-codes.constant.js';
import { runPool } from '../../common/utils/promise-pool.util.js';
import { Lead } from '../entities/lead.entity.js';
import { LeadLiveness } from '../enums/lead.enum.js';
import { parseCsvList } from '../nrd/nrd-filter.js';
import { CRAWLER_UA } from '../enrichment/lead-enrichment.service.js';
import {
  applyParkedVerdict,
  nsIndicatesParking,
} from '../enrichment/parked-detector.js';
import {
  LIVENESS_CONCURRENCY,
  LIVENESS_TIMEOUT_MS,
} from './liveness-tuning.constant.js';
import { PARKING_NS_CSV } from '../enrichment/enrich-tuning.constant.js';

/**
 * Tier-0 of the leads pipeline: "does a website answer for this domain?"
 *
 * Exists because ingest-all made crawl capacity the scarce resource: most
 * day-old NRD domains serve nothing yet, and the enrichment crawler was the
 * thing discovering that, one 10-second timeout at a time. One probe here
 * costs a DNS answer and at most one headerless GET (the body is cancelled
 * unread), so the whole daily intake can be classified for less than a few
 * hundred full crawls used to cost — and the crawler only ever runs against
 * leads this prober tagged `live`.
 *
 * Contract (mirrors enrichLead): per-domain failures are RESULTS recorded on
 * the lead, never throws — an unreachable site is exactly what this service
 * exists to record. Only a missing lead id is an error.
 */
@Injectable()
export class LivenessProbeService {
  private readonly logger = new Logger(LivenessProbeService.name);

  constructor(
    @InjectRepository(Lead)
    private readonly leads: Repository<Lead>,
    private readonly config: ConfigService,
  ) {}

  /** Short on purpose: a live site answers headers well inside 4s, and a
   * hang IS the answer "inactive" — the crawler's 10s stays for real pages. */
  private get timeoutMs(): number {
    return LIVENESS_TIMEOUT_MS;
  }

  private get urlTemplate(): string {
    return (
      this.config.get<string>('leads.enrich.urlTemplate') ?? 'https://{domain}'
    );
  }

  private get parkingSuffixes(): string[] {
    return [...parseCsvList(PARKING_NS_CSV)];
  }

  /**
   * Probes one lead and records the verdict. Writes ONLY the liveness
   * columns — with one documented exception: a parking-nameserver hit also
   * writes the parked verdict (through the same applier the crawler uses),
   * because that fact is DNS-authoritative and settling it here saves the
   * crawl tier the whole trip.
   */
  async probeLead(leadId: string): Promise<Lead> {
    const lead = await this.leads.findOne({ where: { id: leadId } });
    if (!lead) {
      throw new NotFoundException({
        code: ErrorCodes.NOT_FOUND,
        message: 'Lead not found',
      });
    }

    // Parking NS first: Hostinger's parking is literally ns1.dns-parking.com.
    // A parked domain IS being served (liveness live), but by the registrar —
    // the parked status keeps the crawler away and the weekly parked recheck
    // owns it from here. A failed NS lookup is an empty answer, never a hit.
    const nameservers = await resolveNs(lead.domain).catch(
      () => [] as string[],
    );
    if (nsIndicatesParking(nameservers, this.parkingSuffixes)) {
      applyParkedVerdict(lead, null);
      lead.liveness = LeadLiveness.LIVE;
      lead.livenessDetail = 'parking_ns';
      lead.livenessCheckedAt = new Date();
      return this.leads.save(lead);
    }

    const url = this.urlTemplate.replace('{domain}', lead.domain);
    try {
      const response = await fetch(url, {
        redirect: 'follow',
        signal: AbortSignal.timeout(this.timeoutMs),
        headers: { 'User-Agent': CRAWLER_UA },
      });
      // The headers are the whole answer; the body is cancelled unread so a
      // probe never pays for content — that is the crawler's job.
      await response.body?.cancel().catch(() => {});

      if (response.ok) {
        lead.liveness = LeadLiveness.LIVE;
        lead.livenessDetail = 'ok';
      } else {
        // GET, not HEAD, on purpose: plenty of hosts 405 or lie to HEAD, and
        // a HEAD-based "inactive" would misfile real sites. A 4xx/5xx from
        // GET / is an honest "nothing to crawl here today".
        lead.liveness = LeadLiveness.INACTIVE;
        lead.livenessDetail = `http_${response.status}`;
      }
    } catch (err) {
      // fetch does its own DNS, so a nonexistent domain fails right here —
      // no separate resolve step needed. ENOTFOUND is worth naming to the
      // team ("never had DNS" reads differently from "server down"). This
      // branch cannot be e2e'd: the fixture URL template points at
      // 127.0.0.1, so only production probes real names.
      const cause = (err as { cause?: { code?: string } }).cause;
      const code = cause?.code ?? '';
      lead.liveness = LeadLiveness.INACTIVE;
      lead.livenessDetail =
        code === 'ENOTFOUND' || code === 'EAI_AGAIN'
          ? 'no_dns'
          : `fetch_error: ${code || (err as Error).message}`.slice(0, 200);
    }

    lead.livenessCheckedAt = new Date();
    return this.leads.save(lead);
  }

  /**
   * Probes a batch of lead ids with bounded in-process concurrency.
   *
   * A pool here rather than per-lead queue jobs: a probe is milliseconds of
   * DNS + one header round-trip, so fanning 100k+ of them through Redis
   * would cost more bookkeeping than work, and the worker's concurrency (4,
   * sized for full crawls) would throttle a task that is safe at 25 — these
   * are our own outbound lookups, not renders of strangers' pages.
   */
  async probeBatch(ids: string[]): Promise<{ probed: number }> {
    const limit =
      LIVENESS_CONCURRENCY;
    await runPool(ids, limit, async (id) => {
      try {
        await this.probeLead(id);
      } catch (err) {
        // A vanished row (deleted mid-sweep) must not sink the batch.
        this.logger.warn(
          `Liveness probe of ${id} failed: ${(err as Error).message}`,
        );
      }
    });
    return { probed: ids.length };
  }
}
