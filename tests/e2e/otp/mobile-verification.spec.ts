import { test, expect, APIRequestContext } from '@playwright/test';
import { resetDb, closeDb, sql } from '../helpers/db.js';
import { createCustomer, auth, Customer } from '../helpers/actors.js';
import {
  errorOf,
  mobileVerified,
  otpRow,
  phone,
  seedMobileOtp,
  verify,
} from './helpers.js';

/**
 * Mobile verification codes — only the questions
 * tests/e2e/users/mobile-verification.spec.ts cannot reach.
 *
 * `/otp/send` has no verify half, so the only place in this API where an OTP
 * is *checked* is the pair of routes that gate onboarding.
 * users/mobile-verification owns them and already pins the wrong code, the
 * expired code, the replayed code, the exhausted attempt budget, the
 * cross-account guess, the resend cooldown and the hourly cap, and
 * users/access pins the anonymous call — none of that is repeated here.
 *
 * What is left needs either a second live code, which the sixty-second
 * cooldown makes unreachable through the API, or a code the API deliberately
 * never hands back. Both are why these fixtures are inserted directly.
 */
test.describe('mobile verification codes', () => {
  let customer: Customer;

  test.beforeEach(async ({ request }) => {
    await resetDb();
    customer = await createCustomer(request);
  });

  test.afterAll(async () => {
    await closeDb();
  });

  function sendMobileOtp(request: APIRequestContext, mobileNumber: string) {
    return request.post('/users/send-mobile-otp', {
      data: { mobileNumber },
      headers: auth(customer.accessToken),
    });
  }

  test('only the newest unverified code counts, so a superseded one stops working', async ({
    request,
  }) => {
    // Requesting a fresh code has to invalidate the previous one in practice —
    // otherwise every resend widens the guessable surface instead of resetting
    // it. `verifyMobileOtp` orders by createdAt DESC and takes one row, so the
    // older code has nothing to match against. Two live codes cannot be
    // produced through the API (the cooldown forbids it), which is why this is
    // seeded.
    const older = await seedMobileOtp(customer.id, {
      code: '111111',
      createdAt: new Date(Date.now() - 120_000),
    });
    const newer = await seedMobileOtp(customer.id, { code: '222222' });

    const stale = await verify(request, customer.accessToken, '111111');
    expect(stale.status(), 'a superseded code was accepted').toBe(400);
    expect((await errorOf(stale)).code).toBe('INVALID_INPUT');
    expect(await mobileVerified(customer.id)).toBe(false);
    // The guess landed on the newest row, not on the one whose code was sent.
    expect((await otpRow(older)).attempts).toBe(0);
    expect((await otpRow(newer)).attempts).toBe(1);

    const current = await verify(request, customer.accessToken, '222222');
    expect(current.status(), await current.text()).toBe(201);
    expect(await mobileVerified(customer.id)).toBe(true);
    expect((await otpRow(newer)).verified).toBe(true);
  });

  test('a code of the wrong JSON type is refused without costing an attempt', async ({
    request,
  }) => {
    // users/mobile-verification covers the length rule for strings. These are
    // the shapes a client sends by accident — a null field, an array, a nested
    // object — and with `enableImplicitConversion` an object arrives at the
    // validator as '[object Object]', which is a perfectly ordinary string.
    // Each one has to die in the pipe: reaching the service would burn one of
    // the three guesses, and three junk bodies would lock a stranger out of
    // onboarding.
    const id = await seedMobileOtp(customer.id, { code: '424242' });

    for (const otp of [null, [], { otp: '424242' }]) {
      const res = await verify(request, customer.accessToken, otp);
      expect(res.status(), `accepted ${JSON.stringify(otp)}`).toBe(400);
      expect((await errorOf(res)).code).toBe('VALIDATION_ERROR');
    }

    expect((await otpRow(id)).attempts).toBe(0);

    // And the budget really is intact, not merely uncounted.
    const good = await verify(request, customer.accessToken, '424242');
    expect(good.status(), await good.text()).toBe(201);
    expect(await mobileVerified(customer.id)).toBe(true);
  });

  test('the hourly window releases once the older codes age out', async ({
    request,
  }) => {
    // users/mobile-verification pins the cap. What nothing pins is that the
    // window *moves*: if the count were taken over every row rather than the
    // last hour, one bad afternoon would lock an account out of onboarding
    // permanently. The five codes are seeded ten minutes back — inside the
    // hour the cap counts, outside the sixty-second cooldown that would
    // otherwise answer first.
    for (let i = 0; i < 5; i += 1) {
      await seedMobileOtp(customer.id, {
        createdAt: new Date(Date.now() - 10 * 60_000),
      });
    }

    const refused = await sendMobileOtp(request, phone());
    expect(refused.status(), 'a sixth code inside the hour was issued').toBe(
      400,
    );

    await sql(
      `UPDATE "mobile_otps" SET "createdAt" = now() - interval '2 hours'
        WHERE "userId" = $1`,
      [customer.id],
    );

    const allowed = await sendMobileOtp(request, phone());
    expect(allowed.status(), await allowed.text()).toBe(201);

    const [{ count }] = await sql<{ count: string }>(
      `SELECT COUNT(*)::int AS count FROM "mobile_otps" WHERE "userId" = $1`,
      [customer.id],
    );
    expect(Number(count)).toBe(6);
  });
});
