import { Module } from '@nestjs/common';
import { TwoFactorProvider } from './providers/two-factor.provider.js';
import { ConsoleSmsProvider } from './providers/console.provider.js';
import { SmsProviderFactory } from './sms-provider.factory.js';

@Module({
  // Keep Fast2SMS code in repo, but do not make it an active provider.
  // ConsoleSmsProvider is the default dev/test transport (SMS_DRIVER=console).
  providers: [TwoFactorProvider, ConsoleSmsProvider, SmsProviderFactory],
  exports: [SmsProviderFactory],
})
export class SmsProvidersModule {}
