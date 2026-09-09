import { test, expect } from '@playwright/test';
import { resetDb, closeDb } from '../helpers/db.js';
import {
  createCustomer,
  onboardCustomer,
  payload,
  Customer,
} from '../helpers/actors.js';
import {
  balanceOf,
  errorOf,
  FALLBACK_RENDERED,
  messagesFor,
  otpBody,
  otpRequestsFor,
  OTP_COST,
  phone,
  SendResult,
  sendOtp,
  setBalance,
} from './helpers.js';

/**
 * One seam of `POST /otp/send`: what a successful send writes.
 *
 * wallet/otp-billing covers the money path and the obvious rejections; this
 * file goes after what that one takes for granted.
 */

test.describe('OTP send: what a send writes', () => {
  let customer: Customer;

  test.beforeEach(async ({ request }) => {
    await resetDb();
    customer = await createCustomer(request);
    await onboardCustomer(customer.id);
  });

  test.afterAll(async () => {
    await closeDb();
  });

  test('a send reserves nothing and debits nothing until delivery', async ({
    request,
  }) => {
    // Billing is deferred to the first DELIVERED transition: at send time the
    // balance check is a look, not a hold. The intended charge has to be
    // recorded anyway, because that is what the delivery debit reads.
    const res = await sendOtp(request, customer.accessToken, otpBody(phone()));
    expect(res.status(), await res.text()).toBe(201);
    const body = await payload<SendResult>(res);

    expect(await balanceOf(customer.id)).toBe(10);

    const [message] = await messagesFor(customer.id);
    expect(message.id).toBe(body.messageId);
    expect(message.status).toBe('sent');
    expect(Number(message.costAmount)).toBe(0);
    expect(message.metadata?.intendedCost).toBe(OTP_COST);
    expect(message.otpRequestId).toBe(body.otpRequestId);
  });

  test('the balance floor is exactly one OTP, to the paisa', async ({
    request,
  }) => {
    const target = phone();

    // A paisa short of the tariff — 0.2400, written exactly rather than as
    // 0.25 - 0.01, which is not 0.24 in binary floating point.
    await setBalance(customer.id, 0.24);
    const short = await sendOtp(request, customer.accessToken, otpBody(target));
    expect(short.status(), await short.text()).toBe(400);
    expect((await errorOf(short)).code).toBe('INSUFFICIENT_BALANCE');

    // Exactly the tariff is enough: the check is `<`, not `<=`.
    await setBalance(customer.id, OTP_COST);
    const exact = await sendOtp(request, customer.accessToken, otpBody(target));
    expect(exact.status(), await exact.text()).toBe(201);

    // Still not debited at send time, so the floor case cannot go negative.
    expect(await balanceOf(customer.id)).toBe(OTP_COST);
  });

  test('the stored body keeps its wording and loses its digits', async ({
    request,
  }) => {
    // renderedContent is the only record of what the provider was handed, and
    // DLT matching argues over exactly that text — so the wording, spacing and
    // variable substitution must survive while the live code does not.
    const res = await sendOtp(
      request,
      customer.accessToken,
      otpBody(phone(), '123456'),
    );
    expect(res.status(), await res.text()).toBe(201);

    const [message] = await messagesFor(customer.id);
    expect(message.renderedContent).toBe(FALLBACK_RENDERED);
    expect(message.renderedContent).not.toContain('123456');

    // The same code is nonetheless kept in clear on the otp_requests row.
    // Pinned as it behaves today and reported: masking the message body while
    // storing the raw code beside it only moves the exposure.
    const [otpRequest] = await otpRequestsFor(customer.id);
    expect(otpRequest.code).toBe('123456');
  });

  test('a declared variable is substituted into the fallback body', async ({
    request,
  }) => {
    // `expiry` is one of the three keys the DTO declares, so it survives the
    // whitelist and reaches the renderer. The value is a two-digit number so a
    // failure to substitute cannot hide behind the default of 5.
    const res = await sendOtp(request, customer.accessToken, {
      phoneNumber: phone(),
      variables: { otp: '123456', expiry: '11' },
    });
    expect(res.status(), await res.text()).toBe(201);

    const [message] = await messagesFor(customer.id);
    expect(message.renderedContent).toBe(
      'Your verification code is ******. Valid for 11 minutes.',
    );
  });

  test('the request is stamped with the configured five minute expiry', async ({
    request,
  }) => {
    const res = await sendOtp(request, customer.accessToken, otpBody(phone()));
    expect(res.status(), await res.text()).toBe(201);

    const [row] = await otpRequestsFor(customer.id);
    // pg parses timestamptz into a Date, so these are already Dates — wrapping
    // them in `new Date(...)` would not compile (the constructor takes only
    // number | string).
    expect(row.expiresAt).not.toBeNull();
    const lifetime = row.expiresAt!.getTime() - row.createdAt.getTime();
    // OTP_EXPIRY_MINUTES defaults to 5. Two seconds of slack for the round trip
    // between `new Date()` in the service and the row's default `now()`.
    expect(Math.abs(lifetime - 5 * 60_000)).toBeLessThan(2000);
  });

  test('a successful send leaves its request row pending forever', async ({
    request,
  }) => {
    // The row is created PENDING and only the failure path ever moves it. SENT
    // and VERIFIED are declared on the enum and written by nothing, so this
    // column cannot be used to tell a successful send from one still in
    // flight. Pinned as it behaves today and reported.
    const res = await sendOtp(request, customer.accessToken, otpBody(phone()));
    expect(res.status(), await res.text()).toBe(201);
    expect((await payload<SendResult>(res)).status).toBe('sent');

    const [row] = await otpRequestsFor(customer.id);
    expect(row.status).toBe('pending');
  });

  test('the same request sent twice is billed twice, not de-duplicated', async ({
    request,
  }) => {
    // There is no idempotency key on this endpoint, so a retried POST is a
    // second SMS and a second intended charge. Worth pinning explicitly: a
    // client that retries on timeout has to know that.
    const body = otpBody(phone());

    const first = await sendOtp(request, customer.accessToken, body);
    const second = await sendOtp(request, customer.accessToken, body);
    expect(first.status(), await first.text()).toBe(201);
    expect(second.status(), await second.text()).toBe(201);

    const a = await payload<SendResult>(first);
    const b = await payload<SendResult>(second);
    expect(a.otpRequestId).not.toBe(b.otpRequestId);
    expect(a.messageId).not.toBe(b.messageId);
    expect((await messagesFor(customer.id)).length).toBe(2);
  });
});
