import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Message } from './entities/message.entity.js';
import { MessagesService } from './messages.service.js';
import { MessagesController } from './messages.controller.js';
import { DashboardController } from './dashboard.controller.js';
import { ApiKeysModule } from '../api-keys/api-keys.module.js';
import { SmsProvidersModule } from '../sms-providers/sms-providers.module.js';

@Module({
  imports: [
    TypeOrmModule.forFeature([Message]),
    ApiKeysModule,
    SmsProvidersModule,
  ],
  controllers: [MessagesController, DashboardController],
  providers: [MessagesService],
  exports: [MessagesService],
})
export class MessagesModule {}
