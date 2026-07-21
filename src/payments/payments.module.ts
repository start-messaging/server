import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Payment } from './entities/payment.entity.js';
import { PaymentsService } from './payments.service.js';
import { PaymentsController } from './payments.controller.js';
import { PaymentGatewayFactory } from './gateways/payment-gateway.factory.js';
import { RazorpayGateway } from './gateways/razorpay.gateway.js';
import { WalletModule } from '../wallet/wallet.module.js';
import { ReferralModule } from '../referral/referral.module.js';

@Module({
  imports: [TypeOrmModule.forFeature([Payment]), WalletModule, ReferralModule],
  controllers: [PaymentsController],
  providers: [PaymentsService, PaymentGatewayFactory, RazorpayGateway],
  exports: [PaymentsService],
})
export class PaymentsModule {}
