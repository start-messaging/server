import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, Repository } from 'typeorm';
import { randomUUID } from 'crypto';
import { Payment, PaymentStatus } from './entities/payment.entity.js';
import { PaymentGatewayFactory } from './gateways/payment-gateway.factory.js';
import { WalletService } from '../wallet/wallet.service.js';
import {
  WalletTransaction,
  WalletTransactionType,
} from '../wallet/entities/wallet-transaction.entity.js';
import { CreateOrderDto } from './dto/create-order.dto.js';
import { VerifyPaymentDto } from './dto/verify-payment.dto.js';
import { istDayStart } from '../common/utils/date.util.js';
import {
  breakdownFromCharged,
  calculateConvenienceFee,
  ConvenienceFeeConfig,
  DEFAULT_CONVENIENCE_FEE,
} from './convenience-fee.js';

/**
 * What happened when a payment was offered for settlement.
 *
 * `already_settled` is a success, not a failure: every route that can settle a
 * payment (the browser callback, the webhook, the reconciler) may arrive after
 * another one has, and the second is meant to find the work done.
 */
export type SettleOutcome =
  | 'settled'
  | 'already_settled'
  | 'amount_mismatch'
  // Reconciler only — see settleReconciled.
  | 'manual_review'
  | 'would_settle'
  | 'not_found';

/** How far the gateway's reported amount may differ from the order: one paisa of float noise. */
const AMOUNT_TOLERANCE = 0.009;

@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);

  constructor(
    @InjectRepository(Payment)
    private readonly paymentRepository: Repository<Payment>,
    private readonly gatewayFactory: PaymentGatewayFactory,
    private readonly walletService: WalletService,
    private readonly dataSource: DataSource,
    private readonly config: ConfigService,
  ) {}

  /**
   * The fee rate in force.
   *
   * Falls back to the shipped default rather than to "no fee": the surcharge
   * is part of what a top-up costs, so a missing config key must not quietly
   * turn it off and leave the business paying the gateway.
   */
  private feeConfig(): ConvenienceFeeConfig {
    return (
      this.config.get<ConvenienceFeeConfig>('payments.convenienceFee') ??
      DEFAULT_CONVENIENCE_FEE
    );
  }

  /**
   * What a top-up of `amount` will actually cost.
   *
   * Read-only, and the same code path the order uses, so the figure quoted to
   * the customer cannot drift from the figure they are charged.
   */
  quote(amount: number) {
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new BadRequestException('amount must be a positive number');
    }
    return calculateConvenienceFee(amount, this.feeConfig());
  }

  /**
   * What a payment of `charged` rupees is worth as a wallet credit — the
   * reverse of {@link quote}. For an admin crediting a payment received
   * outside the app. Reports the mode in force so the screen can say which
   * arithmetic it used.
   */
  quoteFromCharge(charged: number) {
    if (!Number.isFinite(charged) || charged <= 0) {
      throw new BadRequestException('paid must be a positive number');
    }
    const config = this.feeConfig();
    return { mode: config.mode, ...breakdownFromCharged(charged, config) };
  }

  /** The same quote as {@link quote}, tagged with the mode in force. */
  quoteWithMode(amount: number) {
    return { mode: this.feeConfig().mode, ...this.quote(amount) };
  }

  async createOrder(userId: string, dto: CreateOrderDto) {
    const wallet = await this.walletService.getWallet(userId);
    const currency = wallet.currency;

    const gateway = this.gatewayFactory.getForCurrency(currency);
    const idempotencyKey = randomUUID();

    // `dto.amount` is the credit the customer asked for. When a convenience
    // fee applies, the order is raised for the grossed-up total instead, and
    // the wallet is still credited only what they asked for.
    const fees = calculateConvenienceFee(dto.amount, this.feeConfig());

    const result = await gateway.createOrder({
      amount: fees.chargedAmount,
      currency,
      userId,
      idempotencyKey,
    });

    const payment = this.paymentRepository.create({
      userId,
      gateway: gateway.name,
      gatewayOrderId: result.gatewayOrderId,
      amount: fees.amount,
      convenienceFee: fees.convenienceFee,
      chargedAmount: fees.chargedAmount,
      currency,
      idempotencyKey,
      metadata: result.gatewayData,
    });

    await this.paymentRepository.save(payment);

    return {
      paymentId: payment.id,
      gatewayOrderId: result.gatewayOrderId,
      // The breakdown is returned in full so the checkout can show it. A
      // surcharge the customer only discovers on their statement is not one
      // they were told about, and disclosure before payment is required.
      amount: fees.amount,
      convenienceFee: fees.convenienceFee,
      chargedAmount: fees.chargedAmount,
      currency,
      gatewayKey: gateway.getPublicKey(),
    };
  }

  /** Completed Razorpay checkout totals (wallet top-ups), for admin dashboard. */
  async getRazorpayCompletedStats(): Promise<{
    totalAmount: number;
    todayAmount: number;
    completedCount: number;
  }> {
    // IST day boundary, matching the message and revenue stats it sits beside
    // on the admin dashboard. Server-local midnight disagreed with those on any
    // host not running in IST.
    const todayStart = istDayStart();

    const row = await this.paymentRepository
      .createQueryBuilder('p')
      .select('COALESCE(SUM(p.amount), 0)', 'totalAmount')
      .addSelect(
        `COALESCE(SUM(p.amount) FILTER (WHERE p.createdAt >= :todayStart), 0)`,
        'todayAmount',
      )
      .addSelect('COUNT(*)', 'completedCount')
      .where('p.gateway = :gateway', { gateway: 'razorpay' })
      .andWhere('p.status = :status', { status: PaymentStatus.COMPLETED })
      .setParameter('todayStart', todayStart)
      .getRawOne<{
        totalAmount: string;
        todayAmount: string;
        completedCount: string;
      }>();

    return {
      totalAmount: parseFloat(row?.totalAmount ?? '0'),
      todayAmount: parseFloat(row?.todayAmount ?? '0'),
      completedCount: parseInt(row?.completedCount ?? '0', 10),
    };
  }

  /**
   * Row-locks a payment by its gateway order id.
   *
   * Every route that settles a payment goes through this lock. It, not the
   * transaction isolation level, is what makes "check the status, then credit"
   * safe: a second settler blocks here until the first has committed, then
   * reads COMPLETED and does nothing. (These transactions used to be
   * SERIALIZABLE on top of the lock. That added nothing the lock did not
   * already give, and cost a failure mode: when the browser callback and the
   * webhook landed together, Postgres could abort one with a serialization
   * error, which surfaced as a 500 to a customer who had just paid.)
   */
  private lockByOrderId(
    manager: EntityManager,
    gatewayOrderId: string,
  ): Promise<Payment | null> {
    return manager
      .getRepository(Payment)
      .createQueryBuilder('payment')
      .setLock('pessimistic_write')
      .where('payment.gatewayOrderId = :orderId', { orderId: gatewayOrderId })
      .getOne();
  }

  /**
   * The ONE place a payment becomes COMPLETED and a wallet is credited.
   *
   * The browser callback, the webhook and the reconciler all end here, so
   * "what counts as paid" cannot drift between them. The caller must already
   * hold the row lock from {@link lockByOrderId}.
   *
   * Three guards, cheapest first:
   *  - already COMPLETED: nothing to do.
   *  - the gateway's reported amount must equal what the order was raised for.
   *    A mismatch means the row and the money have diverged, and crediting on
   *    the strength of our own record would credit a figure the customer never
   *    paid. Refusing leaves the payment pending for a human.
   *  - a ledger credit for this payment already exists. Cannot normally happen
   *    under the lock, but if the status and the ledger ever disagree the
   *    ledger wins: the payment is marked COMPLETED and nobody is paid twice.
   *    (UQ_wallet_tx_payment_credit is the backstop behind this check.)
   */
  private async settleCaptured(
    manager: EntityManager,
    payment: Payment,
    captured: { gatewayPaymentId: string; amount?: number },
    source: 'checkout' | 'webhook' | 'reconciliation',
  ): Promise<SettleOutcome> {
    // REFUNDED is as final as COMPLETED. The checkout signature never expires,
    // so a settler that only stopped at COMPLETED let anyone replay the
    // original callback after a refund: the payment flipped back to completed
    // and the wallet was credited for money the business had already returned.
    if (
      payment.status === PaymentStatus.COMPLETED ||
      payment.status === PaymentStatus.REFUNDED
    ) {
      return 'already_settled';
    }

    if (captured.amount !== undefined) {
      const expected = Number(payment.chargedAmount);
      if (Math.abs(Number(captured.amount) - expected) > AMOUNT_TOLERANCE) {
        this.logger.error(
          `Amount mismatch on order ${payment.gatewayOrderId} (${source}): ` +
            `gateway reported ${captured.amount}, order was raised for ${expected}. ` +
            `Not crediting.`,
        );
        return 'amount_mismatch';
      }
    }

    const alreadyCredited = await manager.getRepository(WalletTransaction).exists({
      where: {
        type: WalletTransactionType.CREDIT,
        referenceType: 'payment',
        referenceId: payment.id,
      },
    });

    payment.gatewayPaymentId = captured.gatewayPaymentId;
    payment.status = PaymentStatus.COMPLETED;
    await manager.save(payment);

    if (alreadyCredited) {
      this.logger.warn(
        `Order ${payment.gatewayOrderId} had a wallet credit but was not marked ` +
          `completed (${source}). Marked completed; not credited again.`,
      );
      return 'already_settled';
    }

    await this.walletService.credit(
      payment.userId,
      Number(payment.amount),
      `Payment via ${payment.gateway}`,
      'payment',
      payment.id,
      manager,
    );
    return 'settled';
  }

  async verifyPayment(userId: string, dto: VerifyPaymentDto) {
    return this.dataSource.transaction(async (manager) => {
      const payment = await this.lockByOrderId(manager, dto.razorpayOrderId);

      if (!payment) {
        throw new NotFoundException('Payment not found');
      }

      if (payment.userId !== userId) {
        throw new BadRequestException('Payment does not belong to this user');
      }

      // Idempotent — already completed
      if (payment.status === PaymentStatus.COMPLETED) {
        return { status: 'completed', message: 'Payment already verified' };
      }

      // Said plainly rather than answered with the "completed" a replayed
      // callback would otherwise get: telling a customer a refunded payment
      // is verified would be a lie they could act on.
      if (payment.status === PaymentStatus.REFUNDED) {
        throw new BadRequestException('Payment has been refunded');
      }

      const gateway = this.gatewayFactory.get(payment.gateway);
      const isValid = gateway.verifyPaymentSignature({
        orderId: dto.razorpayOrderId,
        paymentId: dto.razorpayPaymentId,
        signature: dto.razorpaySignature,
      });

      // A bad signature is refused and nothing else. It used to also mark the
      // payment FAILED, but the exception below rolls this transaction back, so
      // that write never landed — and it would have been wrong if it had: a
      // forged request must not be able to fail a genuine pending payment.
      if (!isValid) {
        throw new BadRequestException('Invalid payment signature');
      }

      await this.settleCaptured(
        manager,
        payment,
        { gatewayPaymentId: dto.razorpayPaymentId },
        'checkout',
      );

      return {
        status: 'completed',
        message: 'Payment verified and wallet credited',
      };
    });
  }

  async handleWebhook(
    gatewayName: string,
    body: any,
    signature: string,
    rawBody?: Buffer,
  ) {
    const gateway = this.gatewayFactory.get(gatewayName);
    const result = await gateway.verifyWebhook(body, signature, rawBody);

    if (!result.valid) {
      // 401, not 200. The gateway reads any 2xx as "delivered" and never
      // retries, so answering 200 to a genuine event we could not verify (the
      // webhook secret in the dashboard and the one on this server differ) made
      // the misconfiguration invisible: every payment's webhook was thrown away
      // and the dashboard showed nothing wrong. A 401 is retried by the gateway
      // for a day and listed as a failed delivery in its dashboard, which is
      // exactly where someone will look. A forged request gets 401 and is
      // thereby told nothing it could not already guess.
      this.logger.warn(`Invalid webhook from ${gatewayName}`);
      throw new UnauthorizedException('Invalid webhook signature');
    }

    if (!result.gatewayOrderId || !result.status) {
      return { received: true };
    }

    // Anything thrown from here (a database error, a lock timeout) propagates
    // as a 5xx on purpose: the gateway retries, and the reconciler is behind
    // that. Swallowing the error to answer 200 would be the same silent loss.
    return this.dataSource.transaction(async (manager) => {
      const payment = await this.lockByOrderId(manager, result.gatewayOrderId!);

      if (!payment) {
        this.logger.warn(
          `Payment not found for order ${result.gatewayOrderId}`,
        );
        return { received: true };
      }

      if (
        payment.status === PaymentStatus.COMPLETED ||
        payment.status === PaymentStatus.REFUNDED
      ) {
        return { received: true };
      }

      if (result.status === 'completed' && result.gatewayPaymentId) {
        // A mismatch is acknowledged, not errored: retrying cannot change what
        // the gateway reported, and settleCaptured has logged it at error level.
        await this.settleCaptured(
          manager,
          payment,
          {
            gatewayPaymentId: result.gatewayPaymentId,
            amount: result.amount,
          },
          'webhook',
        );
      } else if (result.status === 'failed') {
        // One failed attempt does not close the order — the customer may retry
        // inside the same checkout and succeed, which settleCaptured accepts
        // from FAILED. Only COMPLETED is final.
        payment.gatewayPaymentId = result.gatewayPaymentId ?? null;
        payment.status = PaymentStatus.FAILED;
        await manager.save(payment);
      }

      return { received: true };
    });
  }

  /**
   * Settles an order the gateway reports as captured, on the reconciler's
   * initiative. This is the path for a payment neither the browser callback
   * nor the webhook delivered.
   *
   * `manual_review` is the guard against paying twice. Before reconciliation
   * existed, a missed payment was fixed by an admin crediting the wallet by
   * hand (referenceType 'admin_topup', or 'admin_payment' since the reason was
   * recorded), and that left the order sitting at
   * `created` — indistinguishable here from one nobody has dealt with. If an
   * admin credited this customer after the order was opened, a human has already
   * been involved, so the order is reported for review instead of credited.
   * Conservative on purpose: an unrelated goodwill credit also trips it, and a
   * flagged order costs one look, where a double credit costs real money.
   *
   * `dryRun` reports `would_settle` for exactly the cases that would settle,
   * and writes nothing.
   */
  async settleReconciled(
    gatewayOrderId: string,
    captured: { id: string; amount: number },
    dryRun = false,
  ): Promise<SettleOutcome> {
    return this.dataSource.transaction(async (manager) => {
      const payment = await this.lockByOrderId(manager, gatewayOrderId);
      if (!payment) return 'not_found';
      if (
        payment.status === PaymentStatus.COMPLETED ||
        payment.status === PaymentStatus.REFUNDED
      ) {
        return 'already_settled';
      }

      const [{ manual }] = await manager.query<{ manual: boolean }[]>(
        `SELECT EXISTS (
           SELECT 1 FROM "wallet_transactions" t
             JOIN "wallets" w ON w."id" = t."walletId"
            WHERE w."userId" = $1
              AND t."referenceType" IN ('admin_topup', 'admin_payment')
              AND t."createdAt" >= $2
         ) AS "manual"`,
        [payment.userId, payment.createdAt],
      );
      if (manual) return 'manual_review';

      if (dryRun) {
        const expected = Number(payment.chargedAmount);
        return Math.abs(captured.amount - expected) > AMOUNT_TOLERANCE
          ? 'amount_mismatch'
          : 'would_settle';
      }

      return this.settleCaptured(
        manager,
        payment,
        { gatewayPaymentId: captured.id, amount: captured.amount },
        'reconciliation',
      );
    });
  }
}
