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
import {
  FeeBearer,
  Payment,
  PaymentStatus,
} from './entities/payment.entity.js';
import { PaymentGatewayFactory } from './gateways/payment-gateway.factory.js';
import { WalletService } from '../wallet/wallet.service.js';
import { CreateOrderDto } from './dto/create-order.dto.js';
import { VerifyPaymentDto } from './dto/verify-payment.dto.js';
import { computeConvenienceFee, microsToPaise } from './fee.util.js';

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

  async createOrder(userId: string, dto: CreateOrderDto) {
    const wallet = await this.walletService.getWallet(userId);
    const currency = wallet.currency;

    const bearer = this.config.get<string>('payments.fee.bearer') ?? 'customer';
    const fee = computeConvenienceFee(dto.amountMicros, {
      feePercent: this.config.get<number>('payments.fee.percent') ?? 2,
      gstPercent: this.config.get<number>('payments.fee.gstPercent') ?? 18,
      bearer,
    });

    const gateway = this.gatewayFactory.getForCurrency(currency);
    const idempotencyKey = randomUUID();

    // The gateway charges the grossed-up total; only the base is credited later.
    const result = await gateway.createOrder({
      amount: fee.totalMicros,
      currency,
      userId,
      idempotencyKey,
      notes: {
        baseMicros: fee.baseMicros,
        convenienceFeeMicros: fee.convenienceFeeMicros,
        gstMicros: fee.gstMicros,
      },
    });

    const payment = this.paymentRepository.create({
      userId,
      gateway: gateway.name,
      gatewayOrderId: result.gatewayOrderId,
      amount: fee.baseMicros,
      convenienceFee: fee.convenienceFeeMicros,
      gst: fee.gstMicros,
      totalAmount: fee.totalMicros,
      feeBearer:
        bearer === 'platform' ? FeeBearer.PLATFORM : FeeBearer.CUSTOMER,
      currency,
      idempotencyKey,
      metadata: result.gatewayData,
    });

    await this.paymentRepository.save(payment);

    return {
      paymentId: payment.id,
      gatewayOrderId: result.gatewayOrderId,
      baseAmountMicros: fee.baseMicros,
      convenienceFeeMicros: fee.convenienceFeeMicros,
      gstMicros: fee.gstMicros,
      totalAmountMicros: fee.totalMicros,
      gatewayAmount: microsToPaise(fee.totalMicros),
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
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

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
