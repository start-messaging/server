import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { AFFILIATE_QUEUE, AffiliateJob } from './affiliate.processor.js';
import { AffiliateSettingsService } from '../services/affiliate-settings.service.js';

/** Stable scheduler ids so re-registering replaces rather than duplicates. */
const ACCRUAL_SCHEDULER = 'affiliate-accrual';
const PAYOUT_SCHEDULER = 'affiliate-payout';
const RECONCILE_SCHEDULER = 'affiliate-reconcile';

@Injectable()
export class AffiliateSchedulerService implements OnModuleInit {
  private readonly logger = new Logger(AffiliateSchedulerService.name);

  constructor(
    @InjectQueue(AFFILIATE_QUEUE) private readonly queue: Queue,
    private readonly settingsService: AffiliateSettingsService,
    private readonly config: ConfigService,
  ) {}

  /**
   * Whether this process should own the repeatable jobs.
   *
   * Off, the API still serves every route and the admin "run now" endpoints
   * still work — only the timers are absent. That is what an end-to-end suite
   * needs (a background accrual firing mid-test consumes the watermark and
   * makes assertions race), and it is also the shape of a deployment that
   * wants its workers on separate instances from its web tier.
   */
  private get schedulingEnabled(): boolean {
    // Through ConfigService, not process.env: Joi declares the variable so a
    // typo is a boot failure instead of silently reading as "on".
    return this.config.get<boolean>('affiliate.schedulerEnabled') !== false;
  }

  onModuleInit(): void {
    if (!this.schedulingEnabled) {
      this.logger.warn(
        'AFFILIATE_SCHEDULER_ENABLED=false — repeatable affiliate jobs not registered. ' +
          'Accrual and payouts will only run when triggered manually.',
      );
      return;
    }

    // Retried in the background rather than awaited once. A single failed
    // attempt used to be the end of it: the error was logged, boot continued,
    // and the repeatable jobs were never registered again for the life of the
    // process — so one Redis blip during a rolling deploy meant no accrual and
    // no payout until somebody noticed and restarted.
    void this.syncWithRetry();
  }

  private async syncWithRetry(): Promise<void> {
    const delaysMs = [1_000, 5_000, 15_000, 60_000, 300_000];

    for (let attempt = 0; ; attempt++) {
      if (await this.syncSchedules()) {
        if (attempt > 0) {
          this.logger.log(
            `Affiliate schedules registered after ${attempt + 1} attempts.`,
          );
        }
        return;
      }

      const delay = delaysMs[Math.min(attempt, delaysMs.length - 1)];
      this.logger.warn(
        `Affiliate schedule registration failed; retrying in ${delay / 1000}s.`,
      );
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  /**
   * Registers the repeatable jobs, replacing any previous definition.
   *
   * `upsertJobScheduler` is keyed on the scheduler id, so booting several
   * instances — or redeploying — converges on one schedule instead of stacking
   * a new repeatable job each time. Called again whenever the accrual interval
   * changes, since that interval is baked into the schedule.
   */
  async syncSchedules(): Promise<boolean> {
    // Also guarded here, not just at boot: an admin changing the accrual
    // interval calls straight into this.
    if (!this.schedulingEnabled) return true;

    try {
      const settings = await this.settingsService.get();

      await this.queue.upsertJobScheduler(
        ACCRUAL_SCHEDULER,
        { every: settings.accrualIntervalHours * 60 * 60 * 1000 },
        {
          name: AffiliateJob.ACCRUAL,
          opts: { removeOnComplete: 50, removeOnFail: 100 },
        },
      );

      // Daily, just after midnight IST. The handler no-ops unless today is the
      // configured payout day, so the schedule never needs to change when an
      // admin moves that day.
      //
      // `tz` is explicit. Without it BullMQ resolves the cron in the process's
      // local timezone, so the comment's "18:30 UTC" was only true when the
      // container happened to run on UTC — and the handler's gate is on the IST
      // calendar day, so a shifted process timezone can move the run onto the
      // wrong side of midnight and skip the payout day entirely.
      //
      // Anchored to Asia/Kolkata directly rather than 18:30 UTC: it expresses
      // the intent ("00:00 IST"), and 00:30 gives half an hour of clearance
      // from the day boundary the gate compares against, instead of landing on
      // it exactly.
      await this.queue.upsertJobScheduler(
        PAYOUT_SCHEDULER,
        { pattern: '30 0 * * *', tz: 'Asia/Kolkata' },
        {
          name: AffiliateJob.PAYOUT,
          opts: { removeOnComplete: 50, removeOnFail: 100 },
        },
      );

      // Weekly safety net: rebuilds the cached totals on `partners` from the
      // commission ledger so cache drift is caught rather than compounding.
      await this.queue.upsertJobScheduler(
        RECONCILE_SCHEDULER,
        { pattern: '0 20 * * 0' },
        {
          name: AffiliateJob.RECONCILE,
          opts: { removeOnComplete: 20, removeOnFail: 50 },
        },
      );

      this.logger.log(
        `Affiliate schedules registered (accrual every ${settings.accrualIntervalHours}h, ` +
          `payout daily gated on day ${settings.payoutDayOfMonth})`,
      );
      return true;
    } catch (err) {
      // Never fatal: the API must still come up if Redis is briefly
      // unavailable, and the jobs can be triggered manually from the admin
      // panel in the meantime. The caller retries.
      this.logger.error(
        `Could not register affiliate schedules: ${(err as Error).message}`,
      );
      return false;
    }
  }
}
