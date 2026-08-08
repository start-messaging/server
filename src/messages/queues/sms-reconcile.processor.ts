import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';
import { MessagesService } from '../messages.service.js';
import { MessageStatus } from '../entities/message.entity.js';

export const SMS_RECONCILE_QUEUE = 'sms-reconcile';

/**
 * Settles messages the provider never told us about.
 *
 * 2Factor posts a delivery webhook only for sends made through its OTP
 * endpoint. Everything sent through the transactional endpoint — which is
 * every multi-variable template since 2026-08-04 — produces no webhook at all,
 * so those messages sat at `sent` indefinitely: never shown as delivered or
 * failed to the customer, and never billed, because the wallet debit fires
 * only on the first transition to DELIVERED.
 *
 * This sweep asks the provider directly for anything still `sent` after a
 * grace period, and feeds the answer through the same `handleStatusUpdate`
 * path a webhook would have taken, so billing and status history behave
 * identically no matter which channel resolved the message.
 */
@Injectable()
@Processor(SMS_RECONCILE_QUEUE)
export class SmsReconcileProcessor extends WorkerHost implements OnModuleInit {
  private readonly logger = new Logger(SmsReconcileProcessor.name);
  private readonly graceMinutes: number;
  private readonly maxAgeHours: number;
  private readonly batchSize: number;
  private readonly everyMs: number;

  constructor(
    private readonly messagesService: MessagesService,
    private readonly config: ConfigService,
    @InjectQueue(SMS_RECONCILE_QUEUE) private readonly queue: Queue,
  ) {
    super();
    // Long enough that a webhook has plainly had its chance, short enough that
    // a customer is not staring at `sent` for an hour.
    this.graceMinutes =
      this.config.get<number>('sms.reconcile.graceMinutes') ?? 10;
    // 2Factor drops a message from its report index after roughly two to
    // three days; measured on production, every stuck message from 2026-08-06
    // onward still had a report and every one from 08-05 and earlier did not.
    // Asking about anything older only burns provider calls on rows that can
    // never be answered — and, because the sweep runs oldest-first, would
    // starve the ones that still can be.
    this.maxAgeHours =
      this.config.get<number>('sms.reconcile.maxAgeHours') ?? 48;
    this.batchSize = this.config.get<number>('sms.reconcile.batchSize') ?? 50;
    this.everyMs =
      (this.config.get<number>('sms.reconcile.intervalMinutes') ?? 5) * 60_000;
  }

  /**
   * Registered as a scheduler rather than a plain repeatable job so restarts
   * and multiple instances converge on one schedule instead of stacking up a
   * new timer per boot.
   */
  async onModuleInit(): Promise<void> {
    if (this.config.get<boolean>('sms.reconcile.enabled') === false) {
      this.logger.warn('SMS reconciliation sweep is disabled by config');
      return;
    }

    await this.queue.upsertJobScheduler(
      'sms-reconcile-sweep',
      { every: this.everyMs },
      { name: 'sweep', opts: { removeOnComplete: true, removeOnFail: 50 } },
    );
    this.logger.log(
      `SMS reconciliation sweep every ${this.everyMs / 60_000}m ` +
        `(grace ${this.graceMinutes}m, window ${this.maxAgeHours}h, ` +
        `batch ${this.batchSize})`,
    );
  }

  /** The sweep takes no job data — the query decides what needs settling. */
  async process(): Promise<{ checked: number; settled: number }> {
    const now = Date.now();
    const settledBefore = new Date(now - this.graceMinutes * 60_000);
    const notBefore = new Date(now - this.maxAgeHours * 3_600_000);
    const stale = await this.messagesService.findStaleSent(
      notBefore,
      settledBefore,
      this.batchSize,
    );

    if (stale.length === 0) return { checked: 0, settled: 0 };

    let settled = 0;
    for (const message of stale) {
      try {
        const updated = await this.messagesService.syncProviderStatus(
          message.id,
        );
        if (
          updated.status === MessageStatus.DELIVERED ||
          updated.status === MessageStatus.FAILED
        ) {
          settled++;
          this.logger.log(
            `Reconciled ${message.id} (${message.provider}) -> ${updated.status}`,
          );
        }
      } catch (err: any) {
        // One unreadable message must not abandon the rest of the batch; it
        // stays `sent` and is picked up by the next sweep.
        this.logger.warn(
          `Reconcile failed for ${message.id}: ${err?.message ?? err}`,
        );
      }
    }

    this.logger.log(
      `Reconciliation sweep: ${stale.length} checked, ${settled} settled`,
    );
    return { checked: stale.length, settled };
  }
}
