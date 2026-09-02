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
  getPublicKey(): string;
  verifyPaymentSignature(params: SignatureVerificationParams): boolean;
}
