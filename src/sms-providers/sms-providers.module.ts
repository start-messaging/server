import { Module } from '@nestjs/common';
import { Fast2SmsProvider } from './providers/fast2sms.provider.js';
import { SmsProviderFactory } from './sms-provider.factory.js';

@Module({
  providers: [Fast2SmsProvider, SmsProviderFactory],
  exports: [SmsProviderFactory],
})
export class SmsProvidersModule {}
