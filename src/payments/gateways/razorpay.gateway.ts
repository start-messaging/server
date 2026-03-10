import {
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'crypto';
import Razorpay from 'razorpay';
import {
  CreateOrderParams,
  CreateOrderResult,
  PaymentGateway,
  SignatureVerificationParams,
  WebhookVerificationResult,
} from './payment-gateway.interface.js';

@Injectable()
export class RazorpayGateway implements PaymentGateway {
  name = 'razorpay';
  private client: Razorpay | null = null;
  private readonly logger = new Logger(RazorpayGateway.name);

  constructor(private readonly config: ConfigService) {
    const keyId = this.config.get<string>('payments.razorpay.keyId');
    const keySecret = this.config.get<string>('payments.razorpay.keySecret');
    if (keyId && keySecret) {
      this.client = new Razorpay({ key_id: keyId, key_secret: keySecret });
    }
  }

  private safeCompare(a: string, b: string): boolean {
    const bufA = Buffer.from(a, 'hex');
    const bufB = Buffer.from(b, 'hex');
    if (bufA.length !== bufB.length) return false;
    return timingSafeEqual(bufA, bufB);
  }

  async createOrder(params: CreateOrderParams): Promise<CreateOrderResult> {
    if (!this.client)
      throw new InternalServerErrorException('Razorpay not configured');

    const order = await this.client.orders.create({
      amount: Math.round(params.amount * 100),
      currency: params.currency,
      receipt: params.idempotencyKey,
    });

    return {
      gatewayOrderId: order.id,
      gatewayData: order as any,
    };
  }

  getPublicKey(): string {
    const keyId = this.config.get<string>('payments.razorpay.keyId');
    if (!keyId)
      throw new InternalServerErrorException('Razorpay key_id not configured');
    return keyId;
  }

  verifyPaymentSignature(params: SignatureVerificationParams): boolean {
    const keySecret = this.config.get<string>('payments.razorpay.keySecret');
    if (!keySecret) return false;

    const expectedSignature = createHmac('sha256', keySecret)
      .update(`${params.orderId}|${params.paymentId}`)
      .digest('hex');

    return this.safeCompare(expectedSignature, params.signature);
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async verifyWebhook(
    body: any,
    signature: string,
  ): Promise<WebhookVerificationResult> {
    const secret = this.config.get<string>('payments.razorpay.webhookSecret');
    if (!secret) return { valid: false };

    const expectedSignature = createHmac('sha256', secret)
      .update(JSON.stringify(body))
      .digest('hex');

    if (!this.safeCompare(expectedSignature, signature)) {
      this.logger.warn('Invalid Razorpay webhook signature');
      return { valid: false };
    }

    const event = body.event;
    const payment = body.payload?.payment?.entity;

    if (event === 'payment.captured' && payment) {
      return {
        valid: true,
        gatewayOrderId: payment.order_id,
        gatewayPaymentId: payment.id,
        amount: payment.amount / 100,
        status: 'completed',
      };
    }

    if (event === 'payment.failed' && payment) {
      return {
        valid: true,
        gatewayOrderId: payment.order_id,
        gatewayPaymentId: payment.id,
        amount: payment.amount / 100,
        status: 'failed',
      };
    }

    return { valid: true };
  }
}
