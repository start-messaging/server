import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TwoFactorProvider } from './providers/two-factor.provider.js';
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
  private readonly isMock: boolean;

  constructor(
    twoFactor: TwoFactorProvider,
    private readonly config: ConfigService,
  ) {
    this.providers = [twoFactor].sort((a, b) => a.priority - b.priority);
    this.isMock = this.config.get<boolean>('MOCK_SMS_SEND') === true;
  }

  async getDeliveryStatus(
    providerName: string,
    providerMsgId: string,
  ): Promise<DlrResult> {
    if (this.isMock && providerName === 'mock') {
      return {
        status: 'delivered',
        description: 'Simulated delivery for mock provider',
        deliveredAt: new Date(),
        senderId: 'MOCK',
        smsLanguage: 'english',
        characterCount: 50,
        smsCount: 1,
        providerCost: 0,
      };
    }

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
    if (this.isMock) {
      if (params.content.includes('000000')) {
        this.logger.warn(`[MOCK SMS] Simulating failure for content: ${params.content}`);
        return {
          provider: 'mock',
          providerMsgId: '',
          status: 'failed',
          failureReason: 'Simulated failure for testing',
        };
      }
      this.logger.log(
        `[MOCK SMS] To: ${params.to}, Content: ${params.content}`,
      );
      return {
        provider: 'mock',
        providerMsgId: `mock_${Date.now()}`,
        status: 'sent',
      };
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
