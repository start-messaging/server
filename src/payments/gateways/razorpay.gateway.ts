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

  /**
   * Constant-time hex comparison that tolerates a missing counterparty.
   *
   * Typed as `unknown` because the value on the other side comes from a header
   * on a public, unauthenticated endpoint: omitting `x-razorpay-signature`
   * entirely made this `Buffer.from(undefined)`, which throws, so anyone could
   * turn the webhook into a 500 with an empty POST. An absent or malformed
   * signature is simply a failed comparison.
   */
  private safeCompare(a: unknown, b: unknown): boolean {
    if (typeof a !== 'string' || typeof b !== 'string') return false;

    const bufA = Buffer.from(a, 'hex');
    const bufB = Buffer.from(b, 'hex');
    if (bufA.length === 0 || bufA.length !== bufB.length) return false;
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
    rawBody?: Buffer,
  ): Promise<WebhookVerificationResult> {
    const secret = this.config.get<string>('payments.razorpay.webhookSecret');
    if (!secret) return { valid: false };

    // Over the bytes Razorpay actually sent, never over JSON.stringify(body).
    //
    // The round trip through the body parser and back out is not the identity:
    // it renormalises unicode escapes, and it reorders any object whose keys
    // look like integers — `notes` is free-form and customer-controlled, so
    // that is reachable. Every such payload produced a signature mismatch on a
    // genuine, correctly-signed webhook.
    //
    // What made that expensive rather than merely wrong is what happens next:
    // handleWebhook answers an invalid webhook with HTTP 201 {received:false},
    // Razorpay reads any 2xx as delivered and never retries, and there is no
    // payment reconciliation sweep anywhere in the codebase. So a captured
    // payment whose customer also never completed the browser callback — a
    // closed tab on the success redirect is enough — was money taken and never
    // credited, with nothing left to notice it.
    //
    // Absent bytes fail closed rather than falling back to the old behaviour:
    // a body parser change that stopped populating rawBody must break loudly
    // here, not silently reopen this.
    if (!rawBody) {
      this.logger.error(
        'Razorpay webhook arrived without a raw body — cannot verify the ' +
          'signature. Check that NestFactory.create is still passing rawBody.',
      );
      return { valid: false };
    }

    const expectedSignature = createHmac('sha256', secret)
      .update(rawBody)
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
