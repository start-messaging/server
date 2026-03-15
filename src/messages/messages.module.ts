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
import { SmsStatusProcessor } from './queues/sms-status.processor.js';

@Module({
  imports: [
    TypeOrmModule.forFeature([Message]),
    ApiKeysModule,
    SmsProvidersModule,
    WalletModule,
    BullModule.registerQueue({
      name: 'sms-status',
    }),
  ],
  controllers: [MessagesController, DashboardController],
  providers: [MessagesService, SmsStatusProcessor],
  exports: [MessagesService, BullModule],
})
export class MessagesModule {}
