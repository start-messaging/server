import { Processor, WorkerHost, OnWorkerEvent } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { CommissionAccrualService } from '../services/commission-accrual.service.js';
import { PartnerPayoutService } from '../services/partner-payout.service.js';

export const AFFILIATE_QUEUE = 'affiliate';

export const AffiliateJob = {
  ACCRUAL: 'accrual',
  PAYOUT: 'payout',
  RECONCILE: 'reconcile',
} as const;

/**
 * Runs the affiliate money jobs.
 *
 * These live on a queue rather than an in-process cron for one reason: with
 * more than one server instance, a `@Cron` decorator fires on every one of
 * them simultaneously. For a job that credits partner balances that means
 * duplicate work at best — and the queue guarantees a scheduled job is
 * delivered to exactly one worker.
 */
@Processor(AFFILIATE_QUEUE)
export class AffiliateProcessor extends WorkerHost {
  private readonly logger = new Logger(AffiliateProcessor.name);

  constructor(
    private readonly accrualService: CommissionAccrualService,
    private readonly payoutService: PartnerPayoutService,
  ) {
    super();
  }

  async process(job: Job): Promise<unknown> {
    switch (job.name) {
      case AffiliateJob.ACCRUAL:
        return this.accrualService.runAccrual();

      case AffiliateJob.PAYOUT: {
        // Fires daily; the service itself decides whether today is the
        // configured payout day. Gating in code rather than in the cron
        // expression means an admin changing the day takes effect immediately
        // instead of after the schedule is re-registered.
        return this.payoutService.runPayouts();
      }

      case AffiliateJob.RECONCILE: {
        const drifted = await this.accrualService.reconcilePartnerTotals();
        return { driftedPartners: drifted.length };
      }

      default:
        this.logger.warn(`Unknown affiliate job: ${job.name}`);
        return { skipped: true };
    }
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job, error: Error) {
    this.logger.error(
      `Affiliate job ${job?.name} (${job?.id}) failed: ${error.message}`,
      error.stack,
    );
  }
}
