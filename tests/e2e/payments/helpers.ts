import { APIRequestContext, APIResponse } from '@playwright/test';
import { createHmac } from 'crypto';
import { sql } from '../helpers/db.js';
import { auth, unique } from '../helpers/actors.js';

/**
 * The shared fixtures behind the seams of `/payments`: the fee quote, order
 * creation, checkout verification and the Razorpay webhook.
 *
 * Two constraints shape everything built here.
 *
 *  - **No test may reach Razorpay.** `POST /payments/create-order` calls the
 *    live orders API, and this environment holds dummy credentials, so every
 *    order-creation case here is one that is refused *before* the gateway is
 *    touched: by the guard, by the DTO, or by the currency lookup in
 *    `PaymentGatewayFactory`. An amount large enough to pass `@Min` may only
 *    be sent when something later in `createOrder` — today, only the
 *    unsupported-currency lookup — refuses it before `gateway.createOrder`.
 *  - **Verification and the webhook need no network at all.** Both are plain
 *    HMACs over a secret this suite already knows (.env.e2e), so a real
 *    signature can be produced here and the whole settlement path — including
 *    the money — exercised for real against seeded payment rows.
 *
 * payments/convenience-fee.spec.ts owns the fee arithmetic and the reconciliation
 * constraint; the specs served by this module do not repeat either. What they go
 * after instead is who may call, what happens when the same settlement arrives
 * twice or by both routes at once, and what the API does when the figure the
 * gateway reports is not the figure the order was raised for.
 */

/** The checkout signature secret. Razorpay signs `${orderId}|${paymentId}` with it. */
export const KEY_SECRET = process.env.RAZORPAY_KEY_SECRET ?? '';

/** The webhook secret. Signs the raw request body, byte for byte. */
export const WEBHOOK_SECRET = process.env.RAZORPAY_WEBHOOK_SECRET ?? '';

/**
 * The shipped fee on a ₹1,000 top-up: credit ₹1,000, charge ₹1,020.
 *
 * Every seeded payment uses this split so that "credited" and "charged" are
 * never the same number — a settlement path that confuses the two would pass
 * against a fee-free fixture and cost the business ₹20 a payment in production.
 */
export const CREDIT = 1000;
export const FEE = 20;
export const CHARGED = 1020;

/** Errors on this API are `{ code, message }` under `error`, with optional `details`. */
export async function errorOf(
  res: APIResponse,
): Promise<{ code: string; message: string; details?: { message: string }[] }> {
  const text = await res.text();
  const body = JSON.parse(text) as {
    error?: { code: string; message: string; details?: { message: string }[] };
  };
  if (!body.error) {
    throw new Error(`expected an error envelope, got: ${text.slice(0, 300)}`);
  }
  return body.error;
}

/** Every validation complaint on one line, for asserting what the DTO objected to. */
export async function complaints(res: APIResponse): Promise<string> {
  const error = await errorOf(res);
  return (error.details ?? [{ message: error.message }])
    .map((d) => d.message)
    .join(' | ');
}

export async function balanceOf(userId: string): Promise<number> {
  const [row] = await sql<{ balance: string }>(
    `SELECT "balance" FROM "wallets" WHERE "userId" = $1`,
    [userId],
  );
  return Number(row?.balance ?? 0);
}

/** The wallet credits written against one payment. Length is the idempotency assertion. */
export async function creditsFor(paymentId: string) {
  return sql<{
    amount: string;
    description: string;
    balanceBefore: string;
    balanceAfter: string;
  }>(
    `SELECT "amount", "description", "balanceBefore", "balanceAfter"
       FROM "wallet_transactions"
      WHERE "referenceType" = 'payment' AND "referenceId" = $1
      ORDER BY "createdAt"`,
    [paymentId],
  );
}

export async function paymentRow(id: string) {
  const [row] = await sql<{
    status: string;
    gatewayPaymentId: string | null;
    amount: string;
    convenienceFee: string;
    chargedAmount: string;
  }>(
    `SELECT "status", "gatewayPaymentId", "amount", "convenienceFee", "chargedAmount"
       FROM "payments" WHERE "id" = $1`,
    [id],
  );
  return row;
}

export async function paymentCountFor(userId: string): Promise<number> {
  const [row] = await sql<{ count: number }>(
    `SELECT COUNT(*)::int AS count FROM "payments" WHERE "userId" = $1`,
    [userId],
  );
  return Number(row.count);
}

export interface SeededPayment {
  id: string;
  orderId: string;
  paymentId: string;
  amount: number;
  chargedAmount: number;
}

/**
 * Writes a payment row the way create-order would have.
 *
 * Direct insertion rather than the API for the reason at the top of the file:
 * raising a real order means calling Razorpay. Everything downstream of the
 * row — signature checking, ownership, the wallet credit — is the real code
 * path either way, because none of it consults the gateway over the network.
 */
export async function seedPayment(opts: {
  userId: string;
  amount?: number;
  convenienceFee?: number;
  chargedAmount?: number;
  status?: 'created' | 'processing' | 'completed' | 'failed' | 'refunded';
  gateway?: string;
  gatewayPaymentId?: string | null;
  deleted?: boolean;
}): Promise<SeededPayment> {
  const orderId = unique('order');
  const amount = opts.amount ?? CREDIT;
  const convenienceFee = opts.convenienceFee ?? FEE;
  const chargedAmount = opts.chargedAmount ?? amount + convenienceFee;

  const [row] = await sql<{ id: string }>(
    `INSERT INTO "payments"
       ("userId", "gateway", "gatewayOrderId", "gatewayPaymentId", "amount",
        "convenienceFee", "chargedAmount", "currency", "status",
        "idempotencyKey", "deletedAt")
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'INR',
             $8::"payments_status_enum", $9, $10)
     RETURNING "id"`,
    [
      opts.userId,
      opts.gateway ?? 'razorpay',
      orderId,
      opts.gatewayPaymentId ?? null,
      amount,
      convenienceFee,
      chargedAmount,
      opts.status ?? 'created',
      unique('idem'),
      opts.deleted ? new Date() : null,
    ],
  );

  return {
    id: row.id,
    orderId,
    paymentId: `pay_${orderId}`,
    amount,
    chargedAmount,
  };
}

/** What Razorpay Checkout hands back to the browser on success. */
export function checkoutSignature(orderId: string, paymentId: string): string {
  return createHmac('sha256', KEY_SECRET)
    .update(`${orderId}|${paymentId}`)
    .digest('hex');
}

export function verifyBody(
  p: SeededPayment,
  extra: Record<string, unknown> = {},
) {
  return {
    razorpayOrderId: p.orderId,
    razorpayPaymentId: p.paymentId,
    razorpaySignature: checkoutSignature(p.orderId, p.paymentId),
    ...extra,
  };
}

export const postVerify = (
  request: APIRequestContext,
  token: string,
  data: unknown,
) => request.post('/payments/verify', { data, headers: auth(token) });

export const quote = (
  request: APIRequestContext,
  token: string,
  query: string,
) => request.get(`/payments/fee-quote${query}`, { headers: auth(token) });

export const order = (
  request: APIRequestContext,
  token: string,
  data: unknown,
) => request.post('/payments/create-order', { data, headers: auth(token) });

/** A Razorpay webhook envelope. `amount` is in paise, as the gateway sends it. */
export function webhookEvent(
  event: 'payment.captured' | 'payment.failed' | 'payment.authorized',
  opts: { orderId: string; paymentId: string; amountPaise: number },
) {
  return {
    event,
    payload: {
      payment: {
        entity: {
          id: opts.paymentId,
          order_id: opts.orderId,
          amount: opts.amountPaise,
        },
      },
    },
  };
}

/**
 * Signs the exact bytes that will be sent.
 *
 * The gateway re-serialises the parsed body to check the HMAC, so the string
 * signed here has to be the string the server's `JSON.stringify` will produce.
 * Sending the raw text rather than an object is what makes that guaranteed
 * rather than lucky.
 */
export function sign(body: unknown): { raw: string; signature: string } {
  const raw = JSON.stringify(body);
  return {
    raw,
    signature: createHmac('sha256', WEBHOOK_SECRET).update(raw).digest('hex'),
  };
}

export function postWebhook(
  request: APIRequestContext,
  raw: string,
  signature?: string,
) {
  return request.post('/payments/webhook/razorpay', {
    data: raw,
    headers: {
      'Content-Type': 'application/json',
      ...(signature === undefined ? {} : { 'x-razorpay-signature': signature }),
    },
  });
}
