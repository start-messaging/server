import { Processor, WorkerHost, OnWorkerEvent } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Job } from 'bullmq';
import { PaymentReconciliationService } from '../payment-reconciliation.service.js';

export const PAYMENT_RECONCILIATION_QUEUE = 'payment-reconciliation';

export const PaymentReconciliationJob = {
  SWEEP: 'sweep',
} as const;

/**
 * Runs the payment reconciliation sweep.
 *
 * On a queue rather than an in-process timer for the same reason the affiliate
 * and onboarding jobs are: a `@Cron` fires on every running instance at once,
 * and here that would mean every instance asking the gateway about the same
 * orders and racing to credit them. The queue delivers each scheduled sweep to
 * exactly one worker, and the row lock plus the unique ledger index catch the
 * case it cannot — two sweeps overlapping because one ran long.
 */
@Processor(PAYMENT_RECONCILIATION_QUEUE)
export class PaymentReconciliationProcessor extends WorkerHost {
  private readonly logger = new Logger(PaymentReconciliationProcessor.name);

  constructor(
    private readonly reconciliation: PaymentReconciliationService,
    private readonly config: ConfigService,
  ) {
    super();
  }

  async process(job: Job): Promise<unknown> {
    if (job.name !== PaymentReconciliationJob.SWEEP) {
      this.logger.warn(`Ignoring unknown job "${job.name}".`);
      return null;
    }

    // Checked at fire time as well as at registration: a BullMQ job scheduler
    // lives in Redis, not in this process, so one registered by an earlier run
    // keeps producing jobs after the conditions that allowed it stop holding.
    if (this.config.get<boolean>('payments.reconciliation.enabled') !== true) {
      this.logger.warn(
        'Skipping the payment reconciliation sweep: it only runs where ' +
          'NODE_ENV=production.',
      );
      return null;
    }

    const report = await this.reconciliation.run();
    return {
      checked: report.checked,
      entries: report.entries.length,
      errors: report.errors.length,
    };
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job, err: Error): void {
    this.logger.error(
      `Payment reconciliation sweep failed (job ${job?.id}): ${err.message}`,
    );
  }
}
