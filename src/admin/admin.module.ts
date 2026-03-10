import { Module } from '@nestjs/common';
import { AdminController } from './admin.controller.js';
import { UsersModule } from '../users/users.module.js';
import { MessagesModule } from '../messages/messages.module.js';
import { ChannelsModule } from '../channels/channels.module.js';
import { WalletModule } from '../wallet/wallet.module.js';
import { ApiKeysModule } from '../api-keys/api-keys.module.js';

@Module({
  imports: [
    UsersModule,
    MessagesModule,
    ChannelsModule,
    WalletModule,
    ApiKeysModule,
  ],
  controllers: [AdminController],
})
export class AdminModule {}
