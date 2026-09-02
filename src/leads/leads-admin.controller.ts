import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import { InjectQueue } from '@nestjs/bullmq';
import { Job, Queue } from 'bullmq';

import { ErrorCodes } from '../common/constants/error-codes.constant.js';
import { Roles } from '../common/decorators/roles.decorator.js';
import { PaginationQueryDto } from '../common/dto/pagination-query.dto.js';
import { LeadsService } from './leads.service.js';
import { LeadEnrichmentService } from './enrichment/lead-enrichment.service.js';
import { BrowserEnrichmentService } from './enrichment/browser-enrichment.service.js';
import { LivenessProbeService } from './liveness/liveness-probe.service.js';
import { LeadsSettingsService } from './settings/leads-settings.service.js';
import { EnrichRunState } from './queues/enrich-run-state.js';
import { UpdatePipelineSettingsDto } from './dto/update-pipeline-settings.dto.js';
import { OutreachService } from './outreach/outreach.service.js';
import { NrdIngestService, yesterdayInKolkata } from './nrd/nrd-ingest.service.js';
import { LEADS_QUEUE, LeadsJob } from './queues/leads.processor.js';
import { EnrichLeadDto } from './dto/enrich-lead.dto.js';
import { LeadFilterQueryDto } from './dto/lead-filter-query.dto.js';
import { TriggerIngestDto } from './dto/trigger-ingest.dto.js';
import { UpdateLeadDto } from './dto/update-lead.dto.js';
import { QueueOutreachDto } from './dto/queue-outreach.dto.js';
import { CreateSuppressionDto } from './dto/create-suppression.dto.js';
import { SuppressionFilterQueryDto } from './dto/suppression-filter-query.dto.js';
import { PARKED_RECHECK_DAYS } from './enrichment/enrich-tuning.constant.js';

/**
 * `date` minus `offset` calendar days, as YYYY-MM-DD. Done in UTC on the
 * date string itself so the server's timezone can never shift a boundary —
 * the IST question was already answered when `yesterdayInKolkata()` picked
 * the newest date.
 */
function daysBefore(date: string, offset: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - offset);
  return d.toISOString().slice(0, 10);
}

/** One queue job as the pipeline view shows it. */
interface PipelineJobView {
  id: string | null;
  name: string;
  leadId?: string;
  domain?: string | null;
  fileDate?: string;
  failedReason?: string;
  timestamp: number;
}

/**
 * Admin surface for the leads pipeline.
 *
 * Route order matters: the static routes (stats, ingest-runs, pipeline,
 * enrich-sweep/run, settings, suppressions) must be declared before ':id',
 * or Nest routes GET /admin/leads/stats into getOne('stats') and answers
 * with a uuid validation error.
 */
@ApiTags('Admin — Leads')
@ApiBearerAuth()
@Roles('admin')
@Controller('admin/leads')
export class LeadsAdminController {
  constructor(
    private readonly leadsService: LeadsService,
    private readonly enrichment: LeadEnrichmentService,
    private readonly browserEnrichment: BrowserEnrichmentService,
    private readonly liveness: LivenessProbeService,
    private readonly leadsSettings: LeadsSettingsService,
    private readonly enrichRunState: EnrichRunState,
    private readonly outreach: OutreachService,
    private readonly nrdIngest: NrdIngestService,
    @InjectQueue(LEADS_QUEUE) private readonly queue: Queue,
    private readonly config: ConfigService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'List leads (paginated, filterable)' })
  list(@Query() query: LeadFilterQueryDto) {
    return this.leadsService.list(query);
  }

  @Get('stats')
  @ApiOperation({ summary: 'Pipeline totals, status breakdowns, recent runs' })
  stats() {
    return this.leadsService.getStats();
  }

  @Get('ingest-runs')
  @ApiOperation({ summary: 'List NRD ingest runs, newest first' })
  ingestRuns(@Query() query: PaginationQueryDto) {
    return this.leadsService.listIngestRuns(query);
  }

  @Post('ingest/run')
  @ApiOperation({
    summary:
      'Enqueue NRD ingests: one file date, a `days`-deep backfill, or a ' +
      'source-URL override',
  })
  async triggerIngest(@Body() dto: TriggerIngestDto) {
    if (dto.url) {
      // Refused BEFORE anything is enqueued, so a disallowed URL creates
      // zero runs. The service re-checks at fetch time; this is the surface
      // that turns it into a 400 instead of a failed run.
      this.nrdIngest.assertAllowedSourceUrl(dto.url);
      if ((dto.days ?? 1) > 1) {
        // The override is one file, one run — an aggregate spans many days
        // already; enqueuing it N times would just fetch it N times.
        throw new BadRequestException({
          code: ErrorCodes.VALIDATION_ERROR,
          message: 'url is a single-run override; it cannot combine with days',
        });
      }
    }

    const newest = dto.date ?? yesterdayInKolkata();
    const fileDates = Array.from({ length: dto.days ?? 1 }, (_, i) =>
      daysBefore(newest, i),
    );

    for (const fileDate of fileDates) {
      await this.queue.add(
        LeadsJob.NRD_SWEEP,
        {
          fileDate,
          // Admin trigger — bypasses the runtime ingest gate at fire time.
          manual: true,
          ...(dto.url ? { sourceUrl: dto.url } : {}),
          // force re-opens completed days — the backfill path for when the
          // ingest filter widened after those days already ran.
          ...(dto.force ? { force: true } : {}),
        },
        { removeOnComplete: 20, removeOnFail: 20 },
      );
    }

    // `fileDate` survives for the single-date case so the panel's existing
    // "queued <date>" toast keeps working; backfills get the full list.
    return fileDates.length === 1
      ? { enqueued: true, fileDate: fileDates[0], fileDates }
      : { enqueued: true, fileDates };
  }

  @Get('pipeline')
  @ApiOperation({
    summary:
      'Queue + cron visibility: schedules, job counts, and the jobs an ' +
      'operator would ask about',
  })
  async pipeline() {
    // Runtime enrichment settings + the drain's order book come from the
    // database, not Redis, so they stay accurate even mid-outage.
    const settings = await this.leadsSettings.effective();
    const outlook = await this.leadsService.getEnrichmentOutlook(
      settings.enrichRecrawlHours,
      PARKED_RECHECK_DAYS,
    );

    // Every read below goes to Redis, which can be briefly away during a
    // deploy or restart. The panel's health view must degrade to nulls and
    // empty lists — an operator checking WHY things look stuck must never be
    // answered with a 500 caused by the same outage.
    let schedulers: Awaited<ReturnType<Queue['getJobSchedulers']>> = [];
    try {
      schedulers = await this.queue.getJobSchedulers();
    } catch {
      schedulers = [];
    }
    const nextFor = (schedulerId: string): string | null => {
      // upsertJobScheduler's id comes back as `key` (id may be null).
      const s = schedulers.find(
        (x) => x.key === schedulerId || x.id === schedulerId,
      );
      return s?.next ? new Date(s.next).toISOString() : null;
    };

    let counts: Record<string, number> = {};
    let active: Job[] = [];
    let waiting: Job[] = [];
    let delayed: Job[] = [];
    let failed: Job[] = [];
    try {
      [counts, active, waiting, delayed, failed] = await Promise.all([
        this.queue.getJobCounts(
          'waiting',
          'active',
          'delayed',
          'failed',
          'completed',
        ),
        // Active is small by construction (worker concurrency 4); the
        // backlogs are windows — first 20 is what a panel list shows.
        this.queue.getJobs(['active']),
        this.queue.getJobs(['waiting'], 0, 19),
        this.queue.getJobs(['delayed'], 0, 19),
        this.queue.getJobs(['failed'], 0, 19),
      ]);
    } catch {
      counts = {};
      active = [];
      waiting = [];
      delayed = [];
      failed = [];
    }

    // Resolve every job's leadId to its domain with ONE IN query — the
    // panel shows domains, and N+1 lookups over four job lists would hit
    // the database once per row.
    const leadIds = new Set<string>();
    for (const job of [...active, ...waiting, ...delayed, ...failed]) {
      const leadId = (job.data as { leadId?: string } | null)?.leadId;
      if (leadId) leadIds.add(leadId);
    }
    const domains = await this.leadsService.domainsForLeadIds([...leadIds]);

    const view = (job: Job): PipelineJobView => {
      const data = (job.data ?? {}) as { leadId?: string; fileDate?: string };
      return {
        id: job.id ?? null,
        name: job.name,
        ...(data.leadId
          ? { leadId: data.leadId, domain: domains.get(data.leadId) ?? null }
          : {}),
        ...(data.fileDate ? { fileDate: data.fileDate } : {}),
        ...(job.failedReason ? { failedReason: job.failedReason } : {}),
        timestamp: job.timestamp,
      };
    };

    return {
      // Every `enabled` below is the EFFECTIVE runtime setting (panel
      // override, or the default while unset) — the state each sweep actually
      // obeys at fire time, since all three schedules are always registered
      // now. `ingestEnabled` has no env default any more: the panel is its
      // only source, and it is off until switched on here.
      crons: [
        {
          id: 'leads-nrd-sweep',
          label: 'Daily domain ingest',
          enabled: settings.ingestEnabled,
          schedule:
            'Hourly 15:30–21:30 IST (retries are free — completed days ' +
            'short-circuit)',
          next: nextFor('leads-nrd-sweep'),
        },
        {
          id: 'leads-liveness-sweep',
          label: 'Liveness probe',
          enabled: settings.livenessEnabled,
          schedule:
            'Hourly (daily coverage of unknown + due inactive re-probes)',
          next: nextFor('leads-liveness-sweep'),
        },
        {
          id: 'leads-enrich-sweep',
          label: 'Enrichment drain',
          enabled: settings.enrichEnabled,
          schedule:
            'Continuous — drains until nothing is eligible; kicked every ' +
            '5 minutes',
          next: nextFor('leads-enrich-sweep'),
        },
      ],
      counts,
      jobs: {
        active: active.map(view),
        waiting: waiting.map(view),
        delayed: delayed.map(view),
        failed: failed.map(view),
      },
      // The drain's order book: what it WILL do (per pool) and what it has
      // DONE — the "every info, so I can understand properly" block.
      enrichment: {
        running: this.enrichRunState.running,
        startedAt: this.enrichRunState.startedAt?.toISOString() ?? null,
        processedThisRun: this.enrichRunState.processed,
        lastRun: this.enrichRunState.lastRun
          ? {
              startedAt: this.enrichRunState.lastRun.startedAt.toISOString(),
              finishedAt:
                this.enrichRunState.lastRun.finishedAt.toISOString(),
              processed: this.enrichRunState.lastRun.processed,
              stoppedBecause: this.enrichRunState.lastRun.stoppedBecause,
            }
          : null,
        ...outlook,
        // Kept in the enrich-local shape the CrawlerCard renders — the
        // full prefixed set lives on GET /admin/leads/settings.
        settings: {
          enabled: settings.enrichEnabled,
          batchPerSweep: settings.enrichBatchPerSweep,
          concurrency: settings.enrichConcurrency,
          recrawlHours: settings.enrichRecrawlHours,
        },
      },
    };
  }

  @Post('liveness-sweep/run')
  @ApiOperation({ summary: 'Run one liveness sweep now' })
  async triggerLivenessSweep() {
    // `manual: true` bypasses the runtime liveness gate — the same
    // asymmetry as every manual trigger here: settings decide what runs
    // unattended, an admin's explicit click is its own authorization.
    await this.queue.add(
      LeadsJob.LIVENESS_SWEEP,
      { manual: true },
      { removeOnComplete: 20, removeOnFail: 20 },
    );
    return { enqueued: true };
  }

  @Post('enrich-sweep/run')
  @ApiOperation({ summary: 'Start an enrichment drain now' })
  async triggerEnrichSweep() {
    // `manual: true` bypasses the runtime enabled gate — the same asymmetry
    // as ingest/run and the browser enrich button: settings decide what runs
    // unattended, while an admin's explicit click is its own authorization.
    // (If a drain is already running, the job reports itself redundant
    // instead of double-crawling.) This is the panel's rerun button.
    await this.queue.add(
      LeadsJob.ENRICH_SWEEP,
      { manual: true },
      { removeOnComplete: 20, removeOnFail: 20 },
    );
    return { enqueued: true };
  }

  @Get('settings')
  @ApiOperation({
    summary:
      'Runtime enrichment knobs: effective values, stored overrides, and ' +
      'the env defaults they fall back to',
  })
  getSettings() {
    return this.leadsSettings.view();
  }

  @Patch('settings')
  @ApiOperation({
    summary:
      'Update enrichment knobs at runtime (enable/disable, batch, ' +
      'concurrency, recrawl hours). null reverts a field to its env default',
  })
  updateSettings(@Body() dto: UpdatePipelineSettingsDto) {
    // Applies mid-run too: the drain re-reads these every slice, so
    // disabling here stops a running drain at its next slice boundary.
    return this.leadsSettings.update(dto);
  }

  @Get('suppressions')
  @ApiOperation({ summary: 'List suppressed addresses' })
  listSuppressions(@Query() query: SuppressionFilterQueryDto) {
    return this.leadsService.listSuppressions(query);
  }

  @Post('suppressions')
  @ApiOperation({ summary: 'Suppress an address manually' })
  createSuppression(@Body() dto: CreateSuppressionDto) {
    return this.leadsService.createSuppression(dto);
  }

  @Delete('suppressions/:id')
  @ApiOperation({ summary: 'Remove a suppression (hard delete)' })
  removeSuppression(@Param('id', ParseUUIDPipe) id: string) {
    return this.leadsService.removeSuppression(id);
  }

  @Get(':id')
  @ApiOperation({ summary: 'One lead with its outreach events, newest first' })
  getOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.leadsService.getOne(id);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update status/notes/outreachEmail' })
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateLeadDto) {
    return this.leadsService.update(id, dto);
  }

  @Post(':id/probe')
  @ApiOperation({
    summary:
      'Probe the domain now (DNS + one GET) and return the updated lead — ' +
      'the panel’s "check site" button',
  })
  probe(@Param('id', ParseUUIDPipe) id: string) {
    // Synchronous and ungated like :id/enrich: the admin clicked "check
    // site" and wants the verdict behind a spinner, sweep gates or not.
    // Delisting is the other half of that button pair — PATCH
    // status=disqualified (already supported) stops every sweep spending on
    // the lead; PATCH status=new re-lists it.
    return this.liveness.probeLead(id);
  }

  @Post(':id/enrich')
  @ApiOperation({
    summary:
      'Crawl the domain now and return the updated lead (synchronous; works ' +
      'even when the automatic sweep is disabled). `browser: true` renders ' +
      'it in headless Chromium instead',
  })
  enrich(@Param('id', ParseUUIDPipe) id: string, @Body() dto: EnrichLeadDto) {
    // Synchronous on purpose — the admin clicked a button and wants the
    // result; a few seconds behind a spinner beats polling a job id.
    if (dto.browser) {
      // Deliberately NOT gated on LEADS_BROWSER_ENRICH_ENABLED — the same
      // asymmetry as every other manual trigger here: the env gates decide
      // what runs unattended, an admin's explicit click is its own
      // authorization. If the browser genuinely cannot launch, this answers
      // 503 LEADS_BROWSER_UNAVAILABLE naming the config to fix.
      return this.browserEnrichment.browserEnrichLead(id);
    }
    return this.enrichment.enrichLead(id);
  }

  @Post(':id/queue-outreach')
  @ApiOperation({ summary: 'Send the outreach email to this lead' })
  queueOutreach(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: QueueOutreachDto,
  ) {
    return this.outreach.queueOutreach(id, dto);
  }
}
