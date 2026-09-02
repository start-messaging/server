import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { LEADS_QUEUE, LeadsJob } from './leads.processor.js';

/** Stable scheduler ids, so re-registering replaces rather than duplicates. */
const NRD_SCHEDULER = 'leads-nrd-sweep';
const LIVENESS_SCHEDULER = 'leads-liveness-sweep';
const ENRICH_SCHEDULER = 'leads-enrich-sweep';

@Injectable()
export class LeadsSchedulerService implements OnModuleInit {
  private readonly logger = new Logger(LeadsSchedulerService.name);

  constructor(
    @InjectQueue(LEADS_QUEUE) private readonly queue: Queue,
  ) {}

  /**
   * All three schedules register unconditionally; each sweep checks its
   * RUNTIME gate (lead_pipeline_settings, env value as the default) at fire
   * time — team decision: gates are operated from the panel, and always-
   * registered schedules are what make a panel toggle effective in both
   * directions without a redeploy. Everything still defaults OFF: these
   * jobs fetch external sites and write thousands of rows, and
   * `server/.env` points at the production database, so a laptop running
   * the API locally boots with every gate reading false — a registered
   * schedule firing against a disabled gate is one settings read.
   */
  onModuleInit(): void {
    // Retried in the background rather than awaited once, matching the other
    // schedulers: a Redis blip during a rolling deploy must not leave the
    // process running for days with no schedule registered.
    void this.syncWithRetry();
  }

  private async syncWithRetry(): Promise<void> {
    const delaysMs = [1_000, 5_000, 15_000, 60_000, 300_000];

    for (let attempt = 0; ; attempt++) {
      if (await this.syncSchedule()) {
        if (attempt > 0) {
          this.logger.log(
            `Leads schedules registered after ${attempt + 1} attempts.`,
          );
        }
        return;
      }

      const delay = delaysMs[Math.min(attempt, delaysMs.length - 1)];
      this.logger.warn(
        `Leads schedule registration failed; retrying in ${delay / 1000}s.`,
      );
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  async syncSchedule(): Promise<boolean> {
    try {
      {
        // WhoisDS publishes day D on D+1 around 10:00 UTC, with drift. An
        // hourly retry inside a 15:30–21:30 IST window is free because
        // runForDate short-circuits completed runs — the first hour the file
        // exists does the work, every other hour is one SELECT. (A disabled
        // gate makes each fire a settings read and a return.)
        await this.queue.upsertJobScheduler(
          NRD_SCHEDULER,
          { pattern: '30 15-21 * * *', tz: 'Asia/Kolkata' },
          {
            name: LeadsJob.NRD_SWEEP,
            opts: { removeOnComplete: 50, removeOnFail: 100 },
          },
        );
        this.logger.log(
          'NRD ingest sweep scheduled hourly, 15:30-21:30 Asia/Kolkata ' +
            '(runtime setting decides whether it runs).',
        );
      }

      {
        // Hourly with a bounded batch rather than one big daily job: the
        // same daily coverage of the due set (hourly × batch comfortably
        // exceeds the intake), but each job stays minutes long on the
        // shared API box instead of hours, and a crash costs one slice.
        await this.queue.upsertJobScheduler(
          LIVENESS_SCHEDULER,
          { every: 3_600_000 },
          {
            name: LeadsJob.LIVENESS_SWEEP,
            opts: { removeOnComplete: 50, removeOnFail: 100 },
          },
        );
        this.logger.log(
          'Lead liveness sweep scheduled every hour ' +
            '(runtime setting decides whether it runs).',
        );
      }

      // The enrichment KICK: a kick against a disabled or already-draining
      // pipeline is one settings read and a return — the drain, not this
      // interval, decides throughput (it runs until nothing is eligible).
      await this.queue.upsertJobScheduler(
        ENRICH_SCHEDULER,
        { every: 300_000 },
        {
          name: LeadsJob.ENRICH_SWEEP,
          opts: { removeOnComplete: 50, removeOnFail: 100 },
        },
      );
      this.logger.log(
        'Lead enrichment drain kick scheduled every 5 minutes ' +
          '(runtime setting decides whether it runs).',
      );

      return true;
    } catch (err) {
      // Never fatal: the API must still come up if Redis is briefly away.
      this.logger.error(
        `Could not register the leads schedules: ${(err as Error).message}`,
      );
      return false;
    }
  }
}
