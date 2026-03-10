import { Injectable, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RazorpayGateway } from './razorpay.gateway.js';
import { PaymentGateway } from './payment-gateway.interface.js';

@Injectable()
export class PaymentGatewayFactory {
  private readonly gateways: Map<string, PaymentGateway>;

  constructor(
    razorpay: RazorpayGateway,
    private readonly config: ConfigService,
  ) {
    this.gateways = new Map<string, PaymentGateway>([['razorpay', razorpay]]);
  }

  get(name: string): PaymentGateway {
    const gateway = this.gateways.get(name);
    if (!gateway) {
      throw new BadRequestException(`Unknown payment gateway: ${name}`);
    }
    return gateway;
  }

  getForCurrency(currency: string): PaymentGateway {
    const currencyConfig = this.config.get<Record<string, any>>(
      `currencies.config.${currency}`,
    );
    if (!currencyConfig) {
      throw new BadRequestException(`Unsupported currency: ${currency}`);
    }
    return this.get(currencyConfig.gateway);
  }
}
