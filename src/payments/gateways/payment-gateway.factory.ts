import { Injectable, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RazorpayGateway } from './razorpay.gateway.js';
import { FakeGateway } from './fake.gateway.js';
import { PaymentGateway } from './payment-gateway.interface.js';

@Injectable()
export class PaymentGatewayFactory {
  private readonly gateways: Map<string, PaymentGateway>;

  constructor(
    razorpay: RazorpayGateway,
    private readonly config: ConfigService,
  ) {
    // Double lock, same idiom as the console SMS provider: the env flag alone
    // is not enough, NODE_ENV must ALSO be 'test'. A fake gateway reachable in
    // production would mint top-ups for free — every "order" it returned
    // would verify and credit a wallet without a rupee moving. The fake wraps
    // the real gateway and replaces order creation only; verification stays
    // the genuine HMAC code (see fake.gateway.ts).
    const useFake =
      this.config.get<boolean>('payments.fakeGateway') === true &&
      this.config.get<string>('NODE_ENV') === 'test';
    const razorpayGateway: PaymentGateway = useFake
      ? new FakeGateway(razorpay)
      : razorpay;
    this.gateways = new Map<string, PaymentGateway>([
      ['razorpay', razorpayGateway],
    ]);
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
