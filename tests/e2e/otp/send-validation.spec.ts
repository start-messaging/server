import { test, expect } from '@playwright/test';
import { resetDb, closeDb } from '../helpers/db.js';
import {
  createCustomer,
  onboardCustomer,
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
  sendOtp,
} from './helpers.js';

/**
 * One seam of `POST /otp/send`: what the DTO lets through.
 *
 * wallet/otp-billing covers the money path and the obvious rejections; this
 * file goes after what that one takes for granted.
 */

test.describe('OTP send: what the DTO accepts', () => {
  let customer: Customer;

  test.beforeEach(async ({ request }) => {
    await resetDb();
    customer = await createCustomer(request);
    await onboardCustomer(customer.id);
  });

  test.afterAll(async () => {
    await closeDb();
  });

  test('a body missing the pieces the send needs is a validation error', async ({
    request,
  }) => {
    const bodies: Record<string, unknown>[] = [
      {},
      { phoneNumber: phone() },
      { variables: { otp: '123456' } },
      { phoneNumber: phone(), variables: null },
      { phoneNumber: phone(), variables: {} },
      { phoneNumber: phone(), variables: [] },
      { phoneNumber: phone(), variables: 'otp=123456' },
      { phoneNumber: phone(), variables: { otp: null } },
      { phoneNumber: null, variables: { otp: '123456' } },
    ];

    for (const data of bodies) {
      const res = await sendOtp(request, customer.accessToken, data);
      expect(res.status(), `accepted ${JSON.stringify(data)}`).toBe(400);
      expect((await errorOf(res)).code).toBe('VALIDATION_ERROR');
    }

    expect((await otpRequestsFor(customer.id)).length).toBe(0);
    expect(await balanceOf(customer.id)).toBe(10);
  });

  test('a phone number is matched exactly rather than tidied up', async ({
    request,
  }) => {
    // Nothing trims or normalises on the way in, and the rate-limit key is the
    // raw string — so a tolerated spelling would be a second bucket for the
    // same handset and the per-number ceiling would be bypassable by adding a
    // space.
    const good = '+919876543210';
    const variants = [
      ` ${good} `,
      `${good}\n`,
      '+91 9876543210',
      '+91-9876543210',
      '919876543210',
      '09876543210',
      '+915876543210', // fifth digit outside [6-9]
      '+9198765432100', // one digit too many
      '+91987654321', // one digit too few
      `${good}${'0'.repeat(5000)}`, // long input must not hang the matcher
      '+९१९८७६५४३२१०', // Devanagari digits are not \d
    ];

    for (const phoneNumber of variants) {
      const res = await sendOtp(
        request,
        customer.accessToken,
        otpBody(phoneNumber),
      );
      expect(res.status(), `accepted "${phoneNumber.slice(0, 40)}"`).toBe(400);
      expect((await errorOf(res)).code).toBe('VALIDATION_ERROR');
    }

    // A number given as a JSON number is coerced to a string by the global
    // pipe and then fails the same pattern — 400, never a 500 on `.match`.
    const numeric = await sendOtp(request, customer.accessToken, {
      phoneNumber: 919876543210,
      variables: { otp: '123456' },
    });
    expect(numeric.status(), await numeric.text()).toBe(400);

    expect((await otpRequestsFor(customer.id)).length).toBe(0);
  });

  test('an OTP code outside four to six digits never reaches the provider', async ({
    request,
  }) => {
    // wallet/otp-billing already pins '12', '1234567', 'abcdef' and '';
    // these are the shapes it does not cover.
    const codes = [
      '123',
      ' 1234',
      '1234 ',
      '12.34',
      '-1234',
      '+1234',
      '12e5',
      '0x1234',
      '😀😀😀😀',
      '١٢٣٤٥٦', // Arabic-Indic digits
      '1'.repeat(2000),
    ];

    for (const otp of codes) {
      const res = await sendOtp(
        request,
        customer.accessToken,
        otpBody(phone(), otp),
      );
      expect(res.status(), `accepted otp "${otp.slice(0, 20)}"`).toBe(400);
      expect((await errorOf(res)).code).toBe('VALIDATION_ERROR');
    }

    expect((await otpRequestsFor(customer.id)).length).toBe(0);
  });

  test('an OTP sent as a number is coerced to its digits, not stored as junk', async ({
    request,
  }) => {
    // `variables` carries @Type(() => OtpVariablesDto), so the nested object is
    // built as that class; `otp` has no @Type of its own, so class-transformer
    // falls through to enableImplicitConversion and takes design:type = String
    // from the decorator metadata. The JSON number therefore reaches the DTO as
    // '123456', passes /^\d{4,6}$/, and is what the recipient is texted — so it
    // is also what has to be stored.
    const res = await sendOtp(request, customer.accessToken, {
      phoneNumber: phone(),
      variables: { otp: 123456 },
    });
    expect(res.status(), await res.text()).toBe(201);

    const rows = await otpRequestsFor(customer.id);
    expect(rows.length).toBe(1);
    expect(rows[0].code).toBe('123456');
  });

  test('unknown properties in the body are dropped rather than obeyed', async ({
    request,
  }) => {
    // `forbidNonWhitelisted` is off, so extra keys are silently stripped. That
    // is only safe if none of them can steer the write: a caller must not be
    // able to bill another account, zero the cost, or declare the message
    // delivered.
    const victim = await createCustomer(request);
    await onboardCustomer(victim.id);

    const res = await sendOtp(request, customer.accessToken, {
      phoneNumber: phone(),
      variables: { otp: '123456' },
      userId: victim.id,
      costAmount: 0,
      status: 'delivered',
      apiKeyId: '00000000-0000-4000-8000-000000000000',
      metadata: { intendedCost: 0 },
    });
    expect(res.status(), await res.text()).toBe(201);

    const mine = await messagesFor(customer.id);
    expect(mine.length).toBe(1);
    expect(mine[0].status).toBe('sent');
    expect(mine[0].apiKeyId).toBeNull();
    expect(mine[0].metadata?.intendedCost).toBe(OTP_COST);
    expect((await messagesFor(victim.id)).length).toBe(0);
    expect(await balanceOf(victim.id)).toBe(10);
  });

  test('a templateId must be a uuid, and an empty string is not the same as absent', async ({
    request,
  }) => {
    for (const templateId of [
      '',
      'not-a-uuid',
      '123',
      '00000000-0000-4000-8000',
      [],
    ]) {
      const res = await sendOtp(
        request,
        customer.accessToken,
        otpBody(phone(), '123456', { templateId }),
      );
      expect(
        res.status(),
        `accepted templateId ${JSON.stringify(templateId)}`,
      ).toBe(400);
      expect((await errorOf(res)).code).toBe('VALIDATION_ERROR');
    }

    // `null` is the one falsy value @IsOptional lets through, and the service
    // then treats it as "no template" — the opposite of what the empty string
    // does. Worth pinning: the two look interchangeable from a client.
    const res = await sendOtp(
      request,
      customer.accessToken,
      otpBody(phone(), '123456', { templateId: null }),
    );
    expect(res.status(), await res.text()).toBe(201);
  });

  test('a template id that does not exist falls back instead of 404ing', async ({
    request,
  }) => {
    // Deliberate: a deleted or unpublished template must not take the send
    // down. What it must not do is *claim* the template it could not resolve,
    // because the stored template id is what DLT disputes are argued from.
    const res = await sendOtp(
      request,
      customer.accessToken,
      otpBody(phone(), '123456', {
        templateId: '00000000-0000-4000-8000-000000000000',
      }),
    );
    expect(res.status(), await res.text()).toBe(201);

    const [message] = await messagesFor(customer.id);
    expect(message.otpTemplateId).toBeNull();
    expect(message.renderedContent).toBe(FALLBACK_RENDERED);
  });
});
