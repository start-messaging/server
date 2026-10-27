import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import {
  PAYMENT_RECONCILIATION_QUEUE,
  PaymentReconciliationJob,
} from './payment-reconciliation.processor.js';
import { RECONCILE_CRON } from '../constants/reconciliation.constant.js';

/** Stable scheduler id, so re-registering replaces rather than duplicates. */
const SWEEP_SCHEDULER = 'payment-reconciliation-sweep';

@Injectable()
export class PaymentReconciliationSchedulerService implements OnModuleInit {
  private readonly logger = new Logger(
    PaymentReconciliationSchedulerService.name,
  );

  constructor(
    @InjectQueue(PAYMENT_RECONCILIATION_QUEUE) private readonly queue: Queue,
    private readonly config: ConfigService,
  ) {}

  /**
   * Derived from NODE_ENV rather than a flag that defaults off. A flag that
   * nobody remembers to set is how the onboarding reminders ran nowhere for
   * weeks while reading as "on": shipping the code to production is what
   * starts the sweep. CI boots the app as NODE_ENV=test and so never schedules
   * one mid-spec; the specs drive the sweep through the admin endpoint instead.
   */
  private get schedulingEnabled(): boolean {
    return this.config.get<boolean>('payments.reconciliation.enabled') === true;
  }

  onModuleInit(): void {
    if (!this.schedulingEnabled) {
      this.logger.log(
        'Payment reconciliation only runs where NODE_ENV=production — not scheduled here.',
      );
      void this.removeStaleSchedule();
      return;
    }

    // Retried in the background rather than awaited once: a Redis blip during
    // a rolling deploy must not leave the process running for days unscheduled.
    void this.syncWithRetry();
  }

  private async removeStaleSchedule(): Promise<void> {
    try {
      await this.queue.removeJobScheduler(SWEEP_SCHEDULER);
    } catch (err) {
      this.logger.error(
        `Could not remove a stale payment reconciliation schedule: ${(err as Error).message}`,
      );
    }
  }

  private async syncWithRetry(): Promise<void> {
    const delaysMs = [1_000, 5_000, 15_000, 60_000, 300_000];

    for (let attempt = 0; ; attempt++) {
      if (await this.syncSchedule()) return;

      const delay = delaysMs[Math.min(attempt, delaysMs.length - 1)];
      this.logger.warn(
        `Payment reconciliation schedule registration failed; retrying in ${delay / 1000}s.`,
      );
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  async syncSchedule(): Promise<boolean> {
    if (!this.schedulingEnabled) return true;

    try {
      // `tz` explicit so the pattern never depends on the container's clock.
      // Every five minutes is unaffected by the zone today; it is stated so a
      // later edit to a time-of-day pattern cannot silently shift.
      await this.queue.upsertJobScheduler(
        SWEEP_SCHEDULER,
        { pattern: RECONCILE_CRON, tz: 'Asia/Kolkata' },
        {
          name: PaymentReconciliationJob.SWEEP,
          opts: { removeOnComplete: 20, removeOnFail: 100 },
        },
      );
      this.logger.log(`Payment reconciliation scheduled (${RECONCILE_CRON}).`);
      return true;
    } catch (err) {
      this.logger.error(
        `Could not register the payment reconciliation schedule: ${(err as Error).message}`,
      );
      return false;
    }
  }
}
