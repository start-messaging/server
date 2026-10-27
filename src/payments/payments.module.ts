import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Payment } from './entities/payment.entity.js';
import { PaymentsService } from './payments.service.js';
import { PaymentsController } from './payments.controller.js';
import { PaymentGatewayFactory } from './gateways/payment-gateway.factory.js';
import { RazorpayGateway } from './gateways/razorpay.gateway.js';
import { WalletModule } from '../wallet/wallet.module.js';
import { PaymentReconciliationService } from './payment-reconciliation.service.js';
import {
  PAYMENT_RECONCILIATION_QUEUE,
  PaymentReconciliationProcessor,
} from './queues/payment-reconciliation.processor.js';
import { PaymentReconciliationSchedulerService } from './queues/payment-reconciliation-scheduler.service.js';

@Module({
  imports: [
    TypeOrmModule.forFeature([Payment]),
    BullModule.registerQueue({ name: PAYMENT_RECONCILIATION_QUEUE }),
    WalletModule,
  ],
  controllers: [PaymentsController],
  providers: [
    PaymentsService,
    PaymentGatewayFactory,
    RazorpayGateway,
    PaymentReconciliationService,
    PaymentReconciliationProcessor,
    PaymentReconciliationSchedulerService,
  ],
  exports: [PaymentsService, PaymentReconciliationService],
})
export class PaymentsModule {}
