import { randomUUID } from 'crypto';
import {
  CreateOrderParams,
  CreateOrderResult,
  PaymentGateway,
  SignatureVerificationParams,
  WebhookVerificationResult,
} from './payment-gateway.interface.js';

/**
 * Test-only gateway behind PAYMENTS_FAKE_GATEWAY (see the factory, which
 * double-locks it on NODE_ENV === 'test' — a fake gateway reachable in
 * production would mint top-ups for free).
 *
 * It replaces ORDER CREATION only. Everything else — the public key the
 * checkout loads, checkout-signature verification, webhook verification —
 * delegates to the real gateway it wraps, so the settlement specs keep
 * exercising the genuine HMAC code against the test secrets, and an order
 * raised through the fake settles through the same path a real one would.
 * `name` is the wrapped gateway's too: payment rows record it, and
 * verify/webhook resolve the gateway from the row by that name.
 */
export class FakeGateway implements PaymentGateway {
  constructor(private readonly real: PaymentGateway) {}

  get name(): string {
    return this.real.name;
  }

  /**
   * Shaped like the Razorpay order object the service consumes: `id` becomes
   * `gatewayOrderId`, and the object itself is stored as `metadata` — with
   * `amount` in the gateway's minor unit (paise), exactly as Razorpay
   * returns it.
   */
  // eslint-disable-next-line @typescript-eslint/require-await
  async createOrder(params: CreateOrderParams): Promise<CreateOrderResult> {
    const order = {
      id: `order_fake_${randomUUID().replace(/-/g, '').slice(0, 12)}`,
      amount: Math.round(params.amount * 100),
      currency: params.currency,
      receipt: params.idempotencyKey,
      status: 'created',
    };
    return { gatewayOrderId: order.id, gatewayData: order };
  }

  getPublicKey(): string {
    return this.real.getPublicKey();
  }

  verifyPaymentSignature(params: SignatureVerificationParams): boolean {
    return this.real.verifyPaymentSignature(params);
  }

  verifyWebhook(
    body: any,
    signature: string,
    rawBody?: Buffer,
  ): Promise<WebhookVerificationResult> {
    return this.real.verifyWebhook(body, signature, rawBody);
  }
}
