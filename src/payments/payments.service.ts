import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { randomUUID } from 'crypto';
import { Payment, PaymentStatus } from './entities/payment.entity.js';
import { PaymentGatewayFactory } from './gateways/payment-gateway.factory.js';
import { WalletService } from '../wallet/wallet.service.js';
import { CreateOrderDto } from './dto/create-order.dto.js';
import { VerifyPaymentDto } from './dto/verify-payment.dto.js';
import { istDayStart } from '../common/utils/date.util.js';
import {
  calculateConvenienceFee,
  ConvenienceFeeConfig,
} from './convenience-fee.js';

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

  /** The fee configuration in force, resolved once. */
  private feeConfig(): ConvenienceFeeConfig {
    return (
      this.config.get<ConvenienceFeeConfig>('payments.convenienceFee') ?? {
        enabled: false,
        percent: 0,
        gstPercent: 0,
      }
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

  async verifyPayment(userId: string, dto: VerifyPaymentDto) {
    return this.dataSource.transaction('SERIALIZABLE', async (manager) => {
      const payment = await manager
        .getRepository(Payment)
        .createQueryBuilder('payment')
        .setLock('pessimistic_write')
        .where('payment.gatewayOrderId = :orderId', {
          orderId: dto.razorpayOrderId,
        })
        .getOne();

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

      const gateway = this.gatewayFactory.get(payment.gateway);
      const isValid = gateway.verifyPaymentSignature({
        orderId: dto.razorpayOrderId,
        paymentId: dto.razorpayPaymentId,
        signature: dto.razorpaySignature,
      });

      if (!isValid) {
        payment.status = PaymentStatus.FAILED;
        await manager.save(payment);
        throw new BadRequestException('Invalid payment signature');
      }

      payment.gatewayPaymentId = dto.razorpayPaymentId;
      payment.status = PaymentStatus.COMPLETED;
      await manager.save(payment);

      await this.walletService.credit(
        payment.userId,
        Number(payment.amount),
        `Payment via ${payment.gateway}`,
        'payment',
        payment.id,
        manager,
      );

      return {
        status: 'completed',
        message: 'Payment verified and wallet credited',
      };
    });
  }

  async handleWebhook(gatewayName: string, body: any, signature: string) {
    const gateway = this.gatewayFactory.get(gatewayName);
    const result = await gateway.verifyWebhook(body, signature);

    if (!result.valid) {
      this.logger.warn(`Invalid webhook from ${gatewayName}`);
      return { received: false };
    }

    if (!result.gatewayOrderId || !result.status) {
      return { received: true };
    }

    return this.dataSource.transaction('SERIALIZABLE', async (manager) => {
      const payment = await manager
        .getRepository(Payment)
        .createQueryBuilder('payment')
        .setLock('pessimistic_write')
        .where('payment.gatewayOrderId = :orderId', {
          orderId: result.gatewayOrderId,
        })
        .getOne();

      if (!payment) {
        this.logger.warn(
          `Payment not found for order ${result.gatewayOrderId}`,
        );
        return { received: true };
      }

      if (payment.status === PaymentStatus.COMPLETED) {
        return { received: true };
      }

      payment.gatewayPaymentId = result.gatewayPaymentId ?? null;

      if (result.status === 'completed') {
        // The gateway tells us what it actually processed, and until now that
        // was accepted without comparison. It has to match what we raised the
        // order for: a mismatch means the row and the money have diverged, and
        // crediting on the strength of our own record would be crediting a
        // figure the customer never paid. Refusing to settle leaves the
        // payment pending for a human rather than silently getting it wrong.
        const expected = Number(payment.chargedAmount);
        if (
          result.amount !== undefined &&
          Math.abs(Number(result.amount) - expected) > 0.009
        ) {
          this.logger.error(
            `Webhook amount mismatch on order ${result.gatewayOrderId}: ` +
              `gateway reported ${result.amount}, order was raised for ${expected}. ` +
              `Not crediting.`,
          );
          return { received: true };
        }

        payment.status = PaymentStatus.COMPLETED;
        await manager.save(payment);

        await this.walletService.credit(
          payment.userId,
          Number(payment.amount),
          `Payment via ${gatewayName}`,
          'payment',
          payment.id,
          manager,
        );
      } else if (result.status === 'failed') {
        payment.status = PaymentStatus.FAILED;
        await manager.save(payment);
      }

      return { received: true };
    });
  }
}
