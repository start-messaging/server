import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { TagsModule } from '../tags/tags.module.js';
import { AdminController } from './admin.controller.js';
import { UsersModule } from '../users/users.module.js';
import { MessagesModule } from '../messages/messages.module.js';
import { ChannelsModule } from '../channels/channels.module.js';
import { WalletModule } from '../wallet/wallet.module.js';
import { ApiKeysModule } from '../api-keys/api-keys.module.js';
import { PaymentsModule } from '../payments/payments.module.js';
import { User } from '../users/entities/user.entity.js';
import { OnboardingReminder } from '../onboarding/entities/onboarding-reminder.entity.js';
import { GrowthService } from './growth.service.js';

@Module({
  imports: [
    // GrowthService reads across the signup, calling and reminder tables in one
    // pass each. Registering the two repositories here rather than exporting a
    // reporting method from UsersModule and OnboardingModule keeps a read-only
    // ops screen from widening the surface of either owning module.
    TypeOrmModule.forFeature([User, OnboardingReminder]),
    TagsModule,
    UsersModule,
    MessagesModule,
    ChannelsModule,
    WalletModule,
    ApiKeysModule,
    PaymentsModule,
  ],
  controllers: [AdminController],
  providers: [GrowthService],
})
export class AdminModule {}
