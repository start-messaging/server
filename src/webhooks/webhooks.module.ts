import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { TwoFactorWebhookController } from './two-factor-webhook.controller.js';
import { MessagesModule } from '../messages/messages.module.js';

@Module({
  imports: [
    MessagesModule,
    BullModule.registerQueue({
      name: 'sms-webhook',
    }),
  ],
  controllers: [TwoFactorWebhookController],
})
export class WebhooksModule {}
