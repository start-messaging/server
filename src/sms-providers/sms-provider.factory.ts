import { Injectable, Logger } from '@nestjs/common';
import { Fast2SmsProvider } from './providers/fast2sms.provider.js';
import {
  SendSmsParams,
  SendSmsResult,
  SmsProvider,
} from './sms-provider.interface.js';

@Injectable()
export class SmsProviderFactory {
  private readonly providers: SmsProvider[];
  private readonly logger = new Logger(SmsProviderFactory.name);

  constructor(fast2sms: Fast2SmsProvider) {
    this.providers = [fast2sms].sort((a, b) => a.priority - b.priority);
  }

  async getDeliveryStatus(
    providerName: string,
    providerMsgId: string,
  ): Promise<string> {
    const provider = this.providers.find((p) => p.name === providerName);
    if (!provider) {
      this.logger.warn(`Provider "${providerName}" not found for DLR check`);
      return 'unknown';
    }
    return provider.getDeliveryStatus(providerMsgId);
  }

  async send(
    params: SendSmsParams,
  ): Promise<SendSmsResult & { provider: string }> {
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
