import { Module } from '@nestjs/common';
import { TwoFactorProvider } from './providers/two-factor.provider.js';
import { SmsProviderFactory } from './sms-provider.factory.js';

@Module({
  // Keep Fast2SMS code in repo, but do not make it an active provider.
  providers: [TwoFactorProvider, SmsProviderFactory],
  exports: [SmsProviderFactory],
})
export class SmsProvidersModule {}
