import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { OtpRequest } from './entities/otp-request.entity.js';
import { OtpService } from './otp.service.js';
import { OtpController } from './otp.controller.js';
import { WalletModule } from '../wallet/wallet.module.js';
import { SmsProvidersModule } from '../sms-providers/sms-providers.module.js';
import { MessagesModule } from '../messages/messages.module.js';
import { ChannelsModule } from '../channels/channels.module.js';

@Module({
  imports: [
    TypeOrmModule.forFeature([OtpRequest]),
    WalletModule,
    SmsProvidersModule,
    MessagesModule,
    ChannelsModule,
  ],
  controllers: [OtpController],
  providers: [OtpService],
  exports: [OtpService],
})
export class OtpModule {}
