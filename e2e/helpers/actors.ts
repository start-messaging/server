import { APIRequestContext, APIResponse, expect } from '@playwright/test';
import { sql } from './db.js';

/**
 * Unwraps the global response envelope.
 *
 * Every success response is `{ success, statusCode, requestId, timestamp,
 * data }`, so tests that reach for `body.user` silently read undefined. This
 * makes that a loud failure instead.
 */
export async function payload<T = any>(res: APIResponse): Promise<T> {
  const text = await res.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`Expected JSON, got: ${text.slice(0, 300)}`);
  }
  if (
    typeof body === 'object' &&
    body !== null &&
    'data' in (body as Record<string, unknown>)
  ) {
    return (body as { data: T }).data;
  }
  return body as T;
}

/**
 * Builders for the three actor types and for the state the affiliate flows
 * depend on.
 *
 * Delivered messages and completed payments are inserted directly rather than
 * driven through the API: accrual windows on timestamps, so a test has to be
 * able to say "this OTP was delivered nine days ago", which no endpoint
 * allows. Everything else goes through the real HTTP surface.
 */

let counter = 0;
/** Unique per call so a re-run never collides on a unique constraint. */
export function unique(prefix: string): string {
  counter += 1;
  return `${prefix}-${process.pid}-${counter}`;
}

export interface Customer {
  id: string;
  email: string;
  password: string;
  accessToken: string;
}

export async function createCustomer(
  api: APIRequestContext,
  overrides: { email?: string; referralCookie?: string } = {},
): Promise<Customer> {
  const email = overrides.email ?? `${unique('cust')}@example.com`;
  const password = 'Password123!';

  const res = await api.post('/auth/register', {
    data: { email, password, firstName: 'Test', lastName: 'Customer' },
    headers: overrides.referralCookie
      ? { Cookie: `sm_ref=${overrides.referralCookie}` }
      : {},
  });
  // `ok()` rather than a literal: this API answers POST /auth/login with 201
  // even though nothing is created. That is wrong semantically but it is what
  // the deployed dashboard already consumes, so the suite pins the behaviour
  // rather than the ideal.
  expect(res.ok(), await res.text()).toBeTruthy();
  const body = await payload<{ accessToken: string; user: { id: string } }>(
    res,
  );

  return { id: body.user.id, email, password, accessToken: body.accessToken };
}

/**
 * Creates a customer straight in the database.
 *
 * `/auth/register` is throttled to 5/min per IP, and the payout threshold
 * tests need ten qualified referrals each, so bulk fixtures cannot go through
 * the API. The registration path itself is covered by its own suite.
 */
export async function seedCustomer(
  opts: { email?: string } = {},
): Promise<{ id: string; email: string }> {
  const email = opts.email ?? `${unique('seed')}@example.com`;
  const [row] = await sql<{ id: string }>(
    `INSERT INTO "users" ("email", "firstName", "lastName", "role")
     VALUES ($1, 'Seeded', 'Customer', 'customer')
     RETURNING "id"`,
    [email],
  );
  return { id: row.id, email };
}

/** Attributes a seeded user to a partner without going through signup. */
export async function seedReferral(
  partnerId: string,
  userId: string,
  referralCode: string,
  status: 'pending' | 'qualified' | 'blocked' = 'pending',
): Promise<string> {
  const [row] = await sql<{ id: string }>(
    // $4 is cast explicitly: used bare it appears both as an enum column value
    // and as a text comparison, and Postgres refuses to deduce one type for both.
    `INSERT INTO "referrals" ("partnerId", "userId", "referralCode", "status", "qualifiedAt")
     VALUES ($1, $2, $3, $4::"referrals_status_enum",
             CASE WHEN $4::text = 'qualified' THEN now() ELSE NULL END)
     RETURNING "id"`,
    [partnerId, userId, referralCode, status],
  );
  return row.id;
}

/**
 * Registers a customer and promotes it.
 *
 * The register DTO pins `role` to CUSTOMER, so there is no API path to an
 * admin — which is correct, and means the suite has to make one directly.
 */
export async function createAdmin(api: APIRequestContext): Promise<Customer> {
  const admin = await createCustomer(api);
  await sql(`UPDATE "users" SET "role" = 'admin' WHERE "id" = $1`, [admin.id]);

  // Re-login so the token carries the promoted role.
  const res = await api.post('/auth/login', {
    data: { email: admin.email, password: admin.password },
  });
  const body = await payload<{ accessToken: string }>(res);
  return { ...admin, accessToken: body.accessToken };
}

export interface Partner {
  id: string;
  email: string;
  password: string;
  accessToken: string;
  referralCode: string;
}

export async function createPartner(
  api: APIRequestContext,
  opts: { active?: boolean; email?: string } = {},
): Promise<Partner> {
  const email = opts.email ?? `${unique('partner')}@example.com`;
  const password = 'Password123!';

  const res = await api.post('/partner/auth/register', {
    data: { email, password, firstName: 'Test', lastName: 'Partner' },
  });
  expect(res.ok(), await res.text()).toBeTruthy();

  const [row] = await sql<{ id: string; referralCode: string }>(
    `SELECT "id", "referralCode" FROM "partners" WHERE "email" = $1`,
    [email],
  );

  // Partners register as PENDING; most flows need an approved one.
  if (opts.active !== false) {
    await sql(`UPDATE "partners" SET "status" = 'active' WHERE "id" = $1`, [
      row.id,
    ]);
  }

  const login = await api.post('/partner/auth/login', {
    data: { email, password },
  });
  expect(login.ok(), await login.text()).toBeTruthy();
  const body = await payload<{ accessToken: string }>(login);

  return {
    id: row.id,
    email,
    password,
    accessToken: body.accessToken,
    referralCode: row.referralCode,
  };
}

export const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

/**
 * Inserts a delivered message.
 *
 * `updatedAt` is what the accrual windows on, so it is settable independently
 * of `deliveredAt` — that separation is the whole point of the lookback tests.
 */
export async function seedDeliveredMessage(
  userId: string,
  opts: {
    costAmount?: number;
    updatedAt?: Date;
    deliveredAt?: Date;
    status?: string;
  } = {},
): Promise<string> {
  const when = opts.updatedAt ?? new Date();
  const [row] = await sql<{ id: string }>(
    `INSERT INTO "messages"
       ("userId", "phoneNumber", "content", "provider", "status",
        "costAmount", "deliveredAt", "createdAt", "updatedAt")
     VALUES ($1, '+919000000000', 'OTP 123456', 'console', $2, $3, $4, $5, $5)
     RETURNING "id"`,
    [
      userId,
      opts.status ?? 'delivered',
      opts.costAmount ?? 0.25,
      opts.deliveredAt ?? when,
      when,
    ],
  );
  return row.id;
}

/** Marks a referral qualified by giving the user a completed payment. */
export async function seedCompletedPayment(
  userId: string,
  amount = 500,
): Promise<void> {
  await sql(
    `INSERT INTO "payments"
       ("userId", "amount", "status", "currency", "gateway", "gatewayOrderId", "idempotencyKey")
     VALUES ($1, $2, 'completed', 'INR', 'razorpay', $3, $3)`,
    [userId, amount, unique('order')],
  );
}

/** Patches the settings singleton through the admin API, as an admin would. */
export async function updateSettings(
  api: APIRequestContext,
  adminToken: string,
  patch: Record<string, unknown>,
) {
  return api.patch('/admin/affiliate/settings', {
    data: patch,
    headers: auth(adminToken),
  });
}

export async function runAccrual(api: APIRequestContext, adminToken: string) {
  const res = await api.post('/admin/affiliate/jobs/accrual', {
    headers: auth(adminToken),
  });
  expect(res.ok(), await res.text()).toBeTruthy();
  return payload<{
    skipped: boolean;
    reason?: string;
    newlyQualified: number;
    commissionsCreated: number;
    totalAccrued: number;
    partnersCredited: number;
  }>(res);
}

export async function runPayouts(api: APIRequestContext, adminToken: string) {
  const res = await api.post('/admin/affiliate/jobs/payouts', {
    headers: auth(adminToken),
  });
  expect(res.ok(), await res.text()).toBeTruthy();
  return payload<{
    skipped: boolean;
    reason?: string;
    payoutsCreated: number;
    totalAmount: number;
    considered: number;
  }>(res);
}
