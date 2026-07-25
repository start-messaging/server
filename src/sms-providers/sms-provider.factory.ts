import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TwoFactorProvider } from './providers/two-factor.provider.js';
import { ConsoleSmsProvider } from './providers/console.provider.js';
import {
  DlrResult,
  SendSmsParams,
  SendSmsResult,
  SmsProvider,
} from './sms-provider.interface.js';

@Injectable()
export class SmsProviderFactory {
  private readonly providers: SmsProvider[];
  private readonly logger = new Logger(SmsProviderFactory.name);

  constructor(
    twoFactor: TwoFactorProvider,
    private readonly consoleProvider: ConsoleSmsProvider,
    private readonly config: ConfigService,
  ) {
    // Console provider is registered so DLR lookups by stored provider name
    // ('console') resolve; it only reports healthy when the console driver is on.
    this.providers = [twoFactor, consoleProvider].sort(
      (a, b) => a.priority - b.priority,
    );
  }

  private get isConsole(): boolean {
    return this.consoleProvider.isEnabled();
  }

  async getDeliveryStatus(
    providerName: string,
    providerMsgId: string,
  ): Promise<DlrResult> {
    const provider = this.providers.find((p) => p.name === providerName);
    if (!provider) {
      this.logger.warn(`Provider "${providerName}" not found for DLR check`);
      return { status: 'unknown' };
    }
    return provider.getDeliveryStatus(providerMsgId);
  }

  async send(
    params: SendSmsParams,
  ): Promise<SendSmsResult & { provider: string }> {
    if (this.isConsole) {
      const result = await this.consoleProvider.sendSms(params);
      return { ...result, provider: this.consoleProvider.name };
    }

    const healthyProviders: SmsProvider[] = [];
    for (const p of this.providers) {
      if (await p.isHealthy()) {
        healthyProviders.push(p);
      }
    }

    if (healthyProviders.length === 0) {
      return {
        provider: 'none',
        providerMsgId: '',
        status: 'failed',
        failureReason: 'No SMS providers available',
      };
    }

    for (const provider of healthyProviders) {
      try {
        const result = await provider.sendSms(params);
        if (result.status !== 'failed') {
          return { ...result, provider: provider.name };
        }

        // If it's a validation error (not service error), don't try fallback
        if (result.errorType === 'validation') {
          return { ...result, provider: provider.name };
        }

        this.logger.warn(`Provider ${provider.name} failed, trying next`);
      } catch (err: any) {
        this.logger.warn(
          `Provider ${provider.name} threw error: ${err.message}`,
        );
      }
    }

    return {
      provider: healthyProviders[healthyProviders.length - 1].name,
      providerMsgId: '',
      status: 'failed',
      failureReason: 'All SMS providers failed',
    };
  }
}
