import { InjectQueue, OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Job, Queue } from 'bullmq';
import * as Sentry from '@sentry/nestjs';

import { Lead } from '../entities/lead.entity.js';
import { LeadEnrichmentStatus, LeadIngestRunStatus } from '../enums/lead.enum.js';
import { runPool } from '../../common/utils/promise-pool.util.js';
import { NrdIngestService, yesterdayInKolkata } from '../nrd/nrd-ingest.service.js';
import { LeadEnrichmentService } from '../enrichment/lead-enrichment.service.js';
import { BrowserEnrichmentService } from '../enrichment/browser-enrichment.service.js';
import { LivenessProbeService } from '../liveness/liveness-probe.service.js';
import { LeadsSettingsService } from '../settings/leads-settings.service.js';
import { EnrichRunState } from './enrich-run-state.js';
import { LIVENESS_BATCH_PER_SWEEP } from '../liveness/liveness-tuning.constant.js';
import {
  ENRICH_MAX_PER_RUN,
  PARKED_RECHECK_DAYS,
} from '../enrichment/enrich-tuning.constant.js';

export const LEADS_QUEUE = 'leads';

export const LeadsJob = {
  NRD_SWEEP: 'nrd-sweep',
  LIVENESS_SWEEP: 'liveness-sweep',
  ENRICH_SWEEP: 'enrich-sweep',
  ENRICH_LEAD: 'enrich-lead',
  ENRICH_BROWSER: 'enrich-browser',
} as const;

/**
 * Worker for the leads pipeline.
 *
 * The sweeps are singletons via the job scheduler, so concurrency exists for
 * the per-lead enrich jobs — capped low because each one holds an outbound
 * fetch against a stranger's server for up to the enrichment timeout, and
 * this worker shares a process with the API.
 */
@Processor(LEADS_QUEUE, { concurrency: 4 })
export class LeadsProcessor extends WorkerHost {
  private readonly logger = new Logger(LeadsProcessor.name);

  constructor(
    @InjectQueue(LEADS_QUEUE) private readonly queue: Queue,
    @InjectRepository(Lead) private readonly leads: Repository<Lead>,
    private readonly ingest: NrdIngestService,
    private readonly enrichment: LeadEnrichmentService,
    private readonly browserEnrichment: BrowserEnrichmentService,
    private readonly liveness: LivenessProbeService,
    private readonly settings: LeadsSettingsService,
    private readonly runState: EnrichRunState,
    private readonly config: ConfigService,
  ) {
    super();
  }

  async process(job: Job): Promise<unknown> {
    switch (job.name) {
      case LeadsJob.NRD_SWEEP:
        return this.runNrdSweep(
          job.data?.fileDate as string | undefined,
          job.data?.sourceUrl as string | undefined,
          job.data?.force === true,
          job.data?.manual === true,
        );
      case LeadsJob.LIVENESS_SWEEP:
        return this.runLivenessSweep(job.data?.manual === true);
      case LeadsJob.ENRICH_SWEEP:
        return this.runEnrichSweep(job.data?.manual === true);
      case LeadsJob.ENRICH_LEAD:
        return this.enrichLead(job.data.leadId as string);
      case LeadsJob.ENRICH_BROWSER:
        return this.browserEnrichment.browserEnrichLead(
          job.data.leadId as string,
        );
      default:
        this.logger.warn(`Ignoring unknown job "${job.name}".`);
        return null;
    }
  }

  /**
   * Tier-1 enrich, plus the escalation: a reachable site with no contact
   * route gets ONE browser render — the Wix/Shopify/React shells only grow
   * their contact links after JavaScript runs. Gated on the browser tier
   * being enabled for this deployment, and on the claim column being empty:
   * browserAttemptedAt is set before the render ever starts, so a lead is
   * escalated once, ever, no matter how it fails.
   */
  private async enrichLead(leadId: string): Promise<Lead> {
    const result = await this.enrichment.enrichLead(leadId);

    // The escalation keys on NO_CONTACT exactly — PARKED must never reach
    // the browser tier: the only thing a rendered parking template can add
    // is more of the registrar's own contacts, which is precisely the junk
    // the parked status exists to keep out of the row.
    if (
      result.enrichmentStatus === LeadEnrichmentStatus.NO_CONTACT &&
      this.config.get<boolean>('leads.browserEnrich.enabled') === true &&
      result.browserAttemptedAt == null
    ) {
      await this.queue.add(
        LeadsJob.ENRICH_BROWSER,
        { leadId },
        { removeOnComplete: true, removeOnFail: true },
      );
    }
    return result;
  }

  private async runNrdSweep(
    fileDate?: string,
    sourceUrl?: string,
    force = false,
    manual = false,
  ): Promise<unknown> {
    // The gate is a runtime setting (panel-editable, env as default), read
    // at fire time because the schedule is always registered — that is what
    // makes the panel toggle work both ways without a redeploy. Manual runs
    // (which always carry fileDate + manual from the admin trigger) bypass.
    if (!manual) {
      const s = await this.settings.effective();
      if (!s.ingestEnabled) return { skipped: 'disabled' };
    }
    // `force` only ever arrives from the admin trigger; the scheduler
    // enqueues bare NRD_SWEEP jobs, so its hourly retries keep the free
    // completed-day short-circuit.
    const run = await this.ingest.runForDate(
      fileDate ?? yesterdayInKolkata(),
      sourceUrl,
      force,
    );
    // Quiet when nothing matched: the retry window fires hourly and most of
    // those runs are "file not published yet" or "already done".
    if (run.matchedDomains > 0) {
      this.logger.log(
        `NRD ${run.fileDate}: ${run.insertedDomains} new of ` +
          `${run.matchedDomains} matched (${run.totalDomains} lines, ${run.status}).`,
      );
    } else if (run.status === LeadIngestRunStatus.FAILED) {
      this.logger.warn(`NRD ${run.fileDate}: ${run.error}`);
    }
    return run;
  }

  /**
   * Tier-0: tags due leads live/inactive so the crawler only ever spends on
   * sites that answer.
   *
   * The claim is the whole re-probe policy — "not live today does not mean
   * not live in two days" as SQL: unknown leads always qualify; inactive
   * ones come due on an age backoff (daily for the first 14 days after
   * registration, weekly to day 90, monthly after — young domains launch
   * any day now, three-month-old silent ones rarely do, but nothing is ever
   * final). Delisted (disqualified) leads are skipped: the team said stop
   * spending on this one. Fresh unknowns go before re-probes, then the same
   * India-first priority as everywhere else.
   */
  private async runLivenessSweep(
    manual = false,
  ): Promise<{ probed: number; skipped?: string }> {
    // Same runtime gate story as the ingest: always scheduled, checked at
    // fire time, bypassed by an admin's explicit click.
    if (!manual) {
      const s = await this.settings.effective();
      if (!s.livenessEnabled) return { probed: 0, skipped: 'disabled' };
    }
    const batch =
      LIVENESS_BATCH_PER_SWEEP;

    const rows: Array<{ id: string }> = await this.leads.query(
      `SELECT id FROM leads
        WHERE "deletedAt" IS NULL
          AND "status" <> 'disqualified'
          AND (
            "liveness" = 'unknown'
            OR (
              "liveness" = 'inactive'
              AND "livenessCheckedAt" < now() - (CASE
                    WHEN "registeredOn" IS NULL
                      OR "registeredOn" > (CURRENT_DATE - 14) THEN interval '1 day'
                    WHEN "registeredOn" > (CURRENT_DATE - 90) THEN interval '7 days'
                    ELSE interval '30 days'
                  END)
            )
          )
        ORDER BY ("liveness" = 'unknown') DESC,
                 ("isIndian" IS TRUE) DESC, "score" DESC, "createdAt" ASC
        LIMIT $1`,
      [batch],
    );

    // In-process pool, not per-lead jobs — see probeBatch for why. Hourly
    // sweeps × this batch comfortably cover the daily intake plus re-probes.
    const result = await this.liveness.probeBatch(rows.map((r) => r.id));
    if (result.probed > 0) {
      this.logger.log(`Liveness sweep probed ${result.probed} leads.`);
    }
    return result;
  }

  /**
   * The enrichment DRAIN: claims and crawls slice after slice until nothing
   * is eligible, then stops. This replaced a fixed 500-every-15-minutes drip
   * at Vicky's direction — the interval was a throughput ceiling pretending
   * to be a schedule; the drain's only ceilings are concurrency and the
   * per-run safety valve. The scheduler's 5-minute kick merely STARTS a
   * drain when there is new work; it does not pace it.
   *
   * Eligible, exactly as specified: pending + probed live + not delisted —
   * no attempts filter (a lead that errors still exits via the failed
   * status after maxAttempts, so no loop) and no priority ordering (the
   * drain covers everything each cycle, so ordering buys nothing; oldest
   * first keeps claims deterministic). On top of that, two recurring pools:
   * crawled leads whose last crawl is older than the runtime
   * `recrawlHours` (default 48h — sites change, contacts appear), and the
   * weekly parked recheck.
   *
   * All knobs are runtime settings (panel-editable): enabled, batch slice,
   * concurrency, recrawl window. They are re-read every slice, so a panel
   * change — including "stop" — takes effect mid-run within seconds.
   */
  private async runEnrichSweep(
    manual = false,
  ): Promise<{ processed: number; skipped?: string }> {
    const first = await this.settings.effective();
    // The gate stops only the SCHEDULED kicks; a manual run is admin intent
    // and proceeds — the same asymmetry as every other trigger here.
    if (!manual && !first.enrichEnabled) {
      return { processed: 0, skipped: 'disabled' };
    }
    // One drain at a time. An in-process flag suffices because this
    // deployment is one process (see EnrichRunState); a second sweep job
    // arriving mid-drain — the 5-min kick, or an admin click — just reports
    // itself redundant, which is true.
    if (this.runState.running) {
      return { processed: 0, skipped: 'already-running' };
    }

    const recheckDays = PARKED_RECHECK_DAYS;
    // Safety valve, not panel-editable on purpose: whatever the panel sets,
    // one run cannot exceed this many crawls — a re-crawl window shorter than
    // the run itself would otherwise never drain.
    const maxPerRun = ENRICH_MAX_PER_RUN;

    this.runState.start();
    let stoppedBecause: 'drained' | 'disabled' | 'max-per-run' = 'drained';
    try {
      for (;;) {
        // Re-read every slice: the panel's disable/resize applies mid-run.
        const s = await this.settings.effective();
        if (!manual && !s.enrichEnabled) {
          stoppedBecause = 'disabled';
          break;
        }

        // Pool 1 — never crawled: pending + probed live + not delisted.
        // liveness='live' keeps 10s timeouts off dead domains (an
        // 'unknown' lead just waits for its probe); the delist check is
        // the team's "stop spending on this one".
        const pending: Array<{ id: string }> = await this.leads.query(
          `SELECT id FROM leads
            WHERE "enrichmentStatus" = 'pending'
              AND "liveness" = 'live'
              AND "status" <> 'disqualified'
              AND "deletedAt" IS NULL
            ORDER BY "createdAt" ASC
            LIMIT $1`,
          [s.enrichBatchPerSweep],
        );

        // Pool 2 — the re-crawl cycle: already-crawled leads whose last
        // crawl is older than the window re-enter, stalest first. Fills
        // only the slice capacity fresh leads left, so a backlog of
        // never-crawled domains always goes first.
        const staleSlots = s.enrichBatchPerSweep - pending.length;
        const stale: Array<{ id: string }> =
          staleSlots > 0
            ? await this.leads.query(
                `SELECT id FROM leads
                  WHERE "enrichmentStatus" IN ('enriched', 'no_contact')
                    AND "liveness" = 'live'
                    AND "status" <> 'disqualified'
                    AND "deletedAt" IS NULL
                    AND "enrichedAt" < now() - make_interval(hours => $1)
                  ORDER BY "enrichedAt" ASC
                  LIMIT $2`,
                [s.enrichRecrawlHours, staleSlots],
              )
            : [];

        // Pool 3 — weekly parked recheck (a parked domain is a business
        // that hasn't launched; the recheck catches the launch). No
        // liveness gate: parked means the registrar's server IS answering.
        const recheckCap = Math.floor(s.enrichBatchPerSweep / 5);
        const parked: Array<{ id: string }> =
          recheckCap > 0
            ? await this.leads.query(
                `SELECT id FROM leads
                  WHERE "enrichmentStatus" = 'parked'
                    AND "status" <> 'disqualified'
                    AND "deletedAt" IS NULL
                    AND "enrichedAt" < now() - make_interval(days => $1)
                  ORDER BY "enrichedAt" ASC
                  LIMIT $2`,
                [recheckDays, recheckCap],
              )
            : [];

        const ids = [...pending, ...stale, ...parked].map((r) => r.id);
        if (ids.length === 0) break; // drained — the stop condition

        // Crawl the slice in-process at the configured concurrency, then
        // claim again: every crawl moves its lead out of the pool it was
        // claimed from (enriched/no_contact/parked/failed all leave
        // 'pending'; a re-crawl refreshes enrichedAt), so the loop
        // provably shrinks toward the break above.
        await runPool(ids, s.enrichConcurrency, async (leadId) => {
          try {
            await this.enrichLead(leadId);
          } catch (err) {
            // A vanished row must not sink the drain.
            this.logger.warn(
              `Drain crawl of ${leadId} failed: ${(err as Error).message}`,
            );
          }
          this.runState.processed += 1;
        });

        if (this.runState.processed >= maxPerRun) {
          stoppedBecause = 'max-per-run';
          break;
        }
      }

      const processed = this.runState.processed;
      if (processed > 0) {
        this.logger.log(
          `Enrich drain processed ${processed} leads (${stoppedBecause}).`,
        );
      }
      return { processed };
    } finally {
      this.runState.finish(stoppedBecause);
    }
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job, err: Error): void {
    this.logger.error(`Leads job ${job?.name} (${job?.id}) failed: ${err.message}`);
    // captureException no-ops when instrument.ts never initialized Sentry,
    // so no env guard is needed here.
    Sentry.captureException(err);
  }
}
