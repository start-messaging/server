import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BullModule } from '@nestjs/bullmq';

import { Lead } from './entities/lead.entity.js';
import { LeadIngestRun } from './entities/lead-ingest-run.entity.js';
import { LeadOutreachEvent } from './entities/lead-outreach-event.entity.js';
import { OutreachSuppression } from './entities/outreach-suppression.entity.js';
import { LeadPipelineSettings } from './settings/lead-pipeline-settings.entity.js';
import { LeadsSettingsService } from './settings/leads-settings.service.js';
import { EnrichRunState } from './queues/enrich-run-state.js';
import { LeadsService } from './leads.service.js';
import { NrdIngestService } from './nrd/nrd-ingest.service.js';
import { LeadEnrichmentService } from './enrichment/lead-enrichment.service.js';
import { BrowserEnrichmentService } from './enrichment/browser-enrichment.service.js';
import { LivenessProbeService } from './liveness/liveness-probe.service.js';
import { OutreachService } from './outreach/outreach.service.js';
import { SmtpOutreachProvider } from './outreach/smtp-outreach.provider.js';
import { ConsoleOutreachProvider } from './outreach/console-outreach.provider.js';
import { LEADS_QUEUE, LeadsProcessor } from './queues/leads.processor.js';
import { LeadsSchedulerService } from './queues/leads-scheduler.service.js';
import { LeadsAdminController } from './leads-admin.controller.js';
import { OutreachTrackingController } from './outreach/outreach-tracking.controller.js';

/**
 * The customer-acquisition pipeline: daily newly-registered-domain ingest,
 * a contact/qualification crawler, and a capped cold-outreach sender with
 * first-party open/click/unsubscribe tracking.
 *
 * Its own module because it owns a queue, four tables, two crawl/send
 * pipelines and a public tracking surface — none of which belongs to any
 * existing feature. Everything here is env-gated off by default: a deployment
 * that sets none of the LEADS_ / OUTREACH_ variables carries inert code and
 * empty tables, nothing more.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      Lead,
      LeadIngestRun,
      LeadOutreachEvent,
      OutreachSuppression,
      LeadPipelineSettings,
    ]),
    BullModule.registerQueue({ name: LEADS_QUEUE }),
  ],
  providers: [
    LeadsService,
    LeadsSettingsService,
    EnrichRunState,
    NrdIngestService,
    LivenessProbeService,
    LeadEnrichmentService,
    BrowserEnrichmentService,
    OutreachService,
    SmtpOutreachProvider,
    ConsoleOutreachProvider,
    LeadsProcessor,
    LeadsSchedulerService,
  ],
  controllers: [LeadsAdminController, OutreachTrackingController],
})
export class LeadsModule {}
