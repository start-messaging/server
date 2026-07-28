import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
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
  ) {}

  async onModuleInit(): Promise<void> {
    await this.syncSchedules();
  }

  /**
   * Registers the repeatable jobs, replacing any previous definition.
   *
   * `upsertJobScheduler` is keyed on the scheduler id, so booting several
   * instances — or redeploying — converges on one schedule instead of stacking
   * a new repeatable job each time. Called again whenever the accrual interval
   * changes, since that interval is baked into the schedule.
   */
  async syncSchedules(): Promise<void> {
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

      // Daily, just after midnight IST (18:30 UTC). The handler no-ops unless
      // today is the configured payout day, so the schedule never needs to
      // change when an admin moves that day.
      await this.queue.upsertJobScheduler(
        PAYOUT_SCHEDULER,
        { pattern: '30 18 * * *' },
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
    } catch (err) {
      // Never fatal: the API must still come up if Redis is briefly
      // unavailable, and the jobs can be triggered manually from the admin
      // panel in the meantime.
      this.logger.error(
        `Could not register affiliate schedules: ${(err as Error).message}`,
      );
    }
  }
}
