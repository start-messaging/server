import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BullModule } from '@nestjs/bullmq';
import { Message } from './entities/message.entity.js';
import { MessagesService } from './messages.service.js';
import { MessagesController } from './messages.controller.js';
import { DashboardController } from './dashboard.controller.js';
import { ApiKeysModule } from '../api-keys/api-keys.module.js';
import { SmsProvidersModule } from '../sms-providers/sms-providers.module.js';
import { WalletModule } from '../wallet/wallet.module.js';
import { SmsWebhookProcessor } from './queues/sms-webhook.processor.js';
import {
  SMS_RECONCILE_QUEUE,
  SmsReconcileProcessor,
} from './queues/sms-reconcile.processor.js';

@Module({
  imports: [
    TypeOrmModule.forFeature([Message]),
    ApiKeysModule,
    SmsProvidersModule,
    WalletModule,
    BullModule.registerQueue({
      name: 'sms-webhook',
    }),
    BullModule.registerQueue({
      name: SMS_RECONCILE_QUEUE,
    }),
  ],
  controllers: [MessagesController, DashboardController],
  providers: [MessagesService, SmsWebhookProcessor, SmsReconcileProcessor],
  exports: [MessagesService, BullModule],
})
export class MessagesModule {}
