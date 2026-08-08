import { Module } from '@nestjs/common';
import { TagsModule } from '../tags/tags.module.js';
import { AdminController } from './admin.controller.js';
import { UsersModule } from '../users/users.module.js';
import { MessagesModule } from '../messages/messages.module.js';
import { ChannelsModule } from '../channels/channels.module.js';
import { WalletModule } from '../wallet/wallet.module.js';
import { ApiKeysModule } from '../api-keys/api-keys.module.js';
import { PaymentsModule } from '../payments/payments.module.js';

@Module({
  imports: [
    TagsModule,
    UsersModule,
    MessagesModule,
    ChannelsModule,
    WalletModule,
    ApiKeysModule,
    PaymentsModule,
  ],
  controllers: [AdminController],
})
export class AdminModule {}
