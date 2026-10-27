import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Payment, PaymentStatus } from './entities/payment.entity.js';
import { PaymentGatewayFactory } from './gateways/payment-gateway.factory.js';
import { PaymentsService, SettleOutcome } from './payments.service.js';
import {
  RECONCILE_AUTHORIZED_GRACE_MINUTES,
  RECONCILE_LOOKBACK_HOURS,
  RECONCILE_MAX_PER_RUN,
  RECONCILE_MIN_AGE_MINUTES,
} from './constants/reconciliation.constant.js';

export interface ReconcileOptions {
  lookbackHours?: number;
  minAgeMinutes?: number;
  limit?: number;
  /** Report what would be credited and write nothing. */
  dryRun?: boolean;
}

export interface ReconcileEntry {
  paymentId: string;
  gatewayOrderId: string;
  userId: string;
  /** What the wallet is (or would be) credited. */
  amount: number;
  createdAt: Date;
  gatewayPaymentId?: string;
  outcome:
    | Exclude<SettleOutcome, 'not_found' | 'already_settled'>
    // Authorised but never captured: the money is held, not taken. See below.
    | 'authorized_not_captured';
}

export interface ReconcileReport {
  dryRun: boolean;
  /** Orders the gateway was asked about. */
  checked: number;
  /** There were more candidates than `limit`; the oldest were not asked about. */
  capped: boolean;
  /** Only orders where something was found: nothing is listed for an abandoned checkout. */
  entries: ReconcileEntry[];
  /** Orders the gateway could not be asked about (network, rate limit). Retried next run. */
  errors: { gatewayOrderId: string; message: string }[];
}

/**
 * Settles payments the browser callback and the webhook both missed, by asking
 * the gateway directly.
 *
 * Why this exists: crediting used to depend entirely on being told. The
 * browser tells us if the customer's tab survives to the success redirect; the
 * gateway tells us if its webhook is configured, reachable and signed with the
 * secret we hold. Either can fail without a sound — a closed tab, a dropped
 * connection, a webhook never set up — and then a customer has paid and the
 * order sits at `created` forever, with nothing anywhere to notice.
 *
 * The gateway's own record of the order is the authority. This sweep reads it
 * for every order that is still unpaid in our books, and settles through the
 * same routine the other two routes use. It can therefore run as often as
 * wanted and alongside them: whichever route gets there first wins, the others
 * find the work done.
 *
 * It only ever moves an order forward to COMPLETED and only for a payment the
 * gateway reports as `captured` for exactly the amount the order was raised
 * for. It cannot invent money: no capture at the gateway, no credit here.
 */
@Injectable()
export class PaymentReconciliationService {
  private readonly logger = new Logger(PaymentReconciliationService.name);

  /**
   * Orders already warned about, by outcome, since this process started.
   *
   * A held-back order (captured but credited by hand, authorised but not
   * captured, wrong amount) stays that way until a person acts, and the sweep
   * meets it again every five minutes for three days. Warning each time would
   * be ~860 identical lines per order and would bury the lines that matter. One
   * warning per order per process is enough to be seen; the admin report still
   * lists them every time, and a restart re-warns, which is the right moment.
   */
  private readonly warned = new Set<string>();

  constructor(
    @InjectRepository(Payment)
    private readonly paymentRepository: Repository<Payment>,
    private readonly gatewayFactory: PaymentGatewayFactory,
    private readonly payments: PaymentsService,
  ) {}

  async run(opts: ReconcileOptions = {}): Promise<ReconcileReport> {
    const lookbackHours = opts.lookbackHours ?? RECONCILE_LOOKBACK_HOURS;
    const minAgeMinutes = opts.minAgeMinutes ?? RECONCILE_MIN_AGE_MINUTES;
    const limit = opts.limit ?? RECONCILE_MAX_PER_RUN;
    const dryRun = opts.dryRun === true;

    const now = Date.now();
    const newest = new Date(now - minAgeMinutes * 60_000);
    const oldest = new Date(now - lookbackHours * 3_600_000);

    // FAILED is included on purpose: a `payment.failed` event marks the order
    // FAILED, and the customer can then retry inside the same order and pay.
    // Excluding it would leave exactly those customers uncredited.
    // Served by IDX_payments_gateway_status_createdAt.
    const candidates = await this.paymentRepository
      .createQueryBuilder('p')
      .where('p.status IN (:...statuses)', {
        statuses: [
          PaymentStatus.CREATED,
          PaymentStatus.PROCESSING,
          PaymentStatus.FAILED,
        ],
      })
      .andWhere('p.createdAt <= :newest', { newest })
      .andWhere('p.createdAt >= :oldest', { oldest })
      .orderBy('p.createdAt', 'DESC')
      .take(limit + 1)
      .getMany();

    const capped = candidates.length > limit;
    const toCheck = candidates.slice(0, limit);

    const report: ReconcileReport = {
      dryRun,
      checked: 0,
      capped,
      entries: [],
      errors: [],
    };

    // One at a time. The volume is small and the gateway rate-limits; a burst
    // of parallel lookups buys seconds and risks being throttled.
    for (const payment of toCheck) {
      report.checked++;
      try {
        const gateway = this.gatewayFactory.get(payment.gateway);
        const attempts = await gateway.fetchOrderPayments(
          payment.gatewayOrderId,
        );

        const captured = attempts.find((a) => a.status === 'captured');
        const base = {
          paymentId: payment.id,
          gatewayOrderId: payment.gatewayOrderId,
          userId: payment.userId,
          amount: Number(payment.amount),
          createdAt: payment.createdAt,
        };

        if (!captured) {
          // Money the customer authorised but the gateway never captured is
          // not ours and not credited. It is surfaced because it is the one
          // case this sweep cannot fix and that someone must: it means the
          // gateway account is not set to auto-capture, and uncaptured
          // authorisations are refunded to the customer after a few days.
          if (
            attempts.some((a) => a.status === 'authorized') &&
            now - payment.createdAt.getTime() >
              RECONCILE_AUTHORIZED_GRACE_MINUTES * 60_000
          ) {
            report.entries.push({
              ...base,
              outcome: 'authorized_not_captured',
            });
          }
          continue;
        }

        const outcome = await this.payments.settleReconciled(
          payment.gatewayOrderId,
          { id: captured.id, amount: captured.amount },
          dryRun,
        );
        if (outcome === 'already_settled' || outcome === 'not_found') continue;

        report.entries.push({
          ...base,
          gatewayPaymentId: captured.id,
          outcome,
        });
      } catch (err) {
        // Never abort the sweep for one order: the rest are independent, and
        // this one is retried at the next run.
        report.errors.push({
          gatewayOrderId: payment.gatewayOrderId,
          message: (err as Error).message,
        });
      }
    }

    this.logReport(report);
    return report;
  }

  /**
   * Quiet when there is nothing to say, loud when there is.
   *
   * This runs every five minutes. A line per run would bury the one that
   * matters, and the one that matters is a customer who paid and was not
   * credited by either of the routes that should have done it — which means
   * the webhook is broken and somebody should look.
   */
  private logReport(report: ReconcileReport): void {
    for (const e of report.entries) {
      if (e.outcome !== 'settled' && e.outcome !== 'would_settle') {
        const key = `${e.outcome}:${e.gatewayOrderId}`;
        if (this.warned.has(key)) continue;
        // Bounded: a process that runs for months must not grow this forever.
        if (this.warned.size > 5000) this.warned.clear();
        this.warned.add(key);
      }
      const detail = `order ${e.gatewayOrderId} (user ${e.userId}, ₹${e.amount})`;
      switch (e.outcome) {
        case 'settled':
          this.logger.warn(
            `Reconciliation credited ${detail}: the gateway captured the payment ` +
              `but neither the browser callback nor the webhook settled it. ` +
              `If this keeps happening, check the webhook configuration.`,
          );
          break;
        case 'would_settle':
          this.logger.log(`Dry run: would credit ${detail}.`);
          break;
        case 'manual_review':
          this.logger.warn(
            `Captured but NOT credited, needs review: ${detail}. An admin ` +
              `credited this customer after the order was opened, so crediting ` +
              `it again could pay twice.`,
          );
          break;
        case 'amount_mismatch':
          this.logger.error(
            `Captured for an unexpected amount, NOT credited: ${detail}.`,
          );
          break;
        case 'authorized_not_captured':
          this.logger.warn(
            `Authorised but not captured: ${detail}. Check that auto-capture ` +
              `is on for the gateway account.`,
          );
          break;
      }
    }

    if (report.errors.length > 0) {
      this.logger.error(
        `Reconciliation could not check ${report.errors.length} order(s): ` +
          `${report.errors[0].message} (first). They will be retried next run.`,
      );
    }
    if (report.capped) {
      this.logger.warn(
        'Reconciliation had more unpaid orders than it checks per run; the ' +
          'oldest were skipped. If this repeats, raise RECONCILE_MAX_PER_RUN.',
      );
    }
  }
}
