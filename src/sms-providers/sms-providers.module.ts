import { Module } from '@nestjs/common';
import { TwoFactorProvider } from './providers/two-factor.provider.js';
import { ConsoleProvider } from './providers/console.provider.js';
import { SmsProviderFactory } from './sms-provider.factory.js';

@Module({
  // Keep Fast2SMS code in repo, but do not make it an active provider.
  // ConsoleProvider reports unhealthy unless SMS_CONSOLE_PROVIDER=true, so
  // registering it here is inert everywhere it is not explicitly enabled.
  providers: [TwoFactorProvider, ConsoleProvider, SmsProviderFactory],
  exports: [SmsProviderFactory],
})
export class SmsProvidersModule {}
