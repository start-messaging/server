export interface CreateOrderParams {
  amount: number;
  currency: string;
  userId: string;
  idempotencyKey: string;
}

export interface CreateOrderResult {
  gatewayOrderId: string;
  gatewayData: Record<string, any>;
}

export interface WebhookVerificationResult {
  valid: boolean;
  gatewayOrderId?: string;
  gatewayPaymentId?: string;
  amount?: number;
  status?: 'completed' | 'failed';
}

export interface SignatureVerificationParams {
  orderId: string;
  paymentId: string;
  signature: string;
}

/**
 * One attempt to pay an order, as the gateway itself reports it.
 *
 * `status` is the gateway's own word, passed through untouched ('captured' is
 * the only one that means money was taken). `amount` is in major units (rupees),
 * converted from the gateway's minor unit at the boundary so nothing above this
 * file ever has to remember paise.
 */
export interface GatewayOrderPayment {
  id: string;
  status: string;
  amount: number;
}

export interface PaymentGateway {
  name: string;
  createOrder(params: CreateOrderParams): Promise<CreateOrderResult>;
  /**
   * `rawBody` is the exact bytes received. A gateway that signs the request
   * body MUST verify against these and not against a re-serialization of
   * `body`, which is passed only so field extraction stays convenient.
   */
  verifyWebhook(
    body: any,
    signature: string,
    rawBody?: Buffer,
  ): Promise<WebhookVerificationResult>;
  /**
   * Asks the gateway what happened to an order, instead of waiting to be told.
   *
   * This is what lets a payment be settled when neither the browser callback
   * nor the webhook ever arrived — the gateway's own record is the authority,
   * not whichever message happened to reach us.
   */
  fetchOrderPayments(gatewayOrderId: string): Promise<GatewayOrderPayment[]>;
  getPublicKey(): string;
  verifyPaymentSignature(params: SignatureVerificationParams): boolean;
}
