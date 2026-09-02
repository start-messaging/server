import { test, expect } from '@playwright/test';
import { resetDb, closeDb, flushRedis } from '../helpers/db.js';
import {
  createCustomer,
  onboardCustomer,
  Customer,
} from '../helpers/actors.js';
import {
  errorOf,
  messagesFor,
  otpBody,
  otpRequestsFor,
  phone,
  sendOtp,
  SENDS_PER_NUMBER,
  setBalance,
} from './helpers.js';

/**
 * One seam of `POST /otp/send`: the per-number ceiling the OTP service keeps
 * in Redis.
 *
 * wallet/otp-billing covers the money path and the obvious rejections; this
 * file goes after what that one takes for granted.
 */

test.describe('OTP send: the per-number ceiling', () => {
  let customer: Customer;

  test.beforeEach(async ({ request }) => {
    await resetDb();
    customer = await createCustomer(request);
    await onboardCustomer(customer.id);
  });

  test.afterAll(async () => {
    await closeDb();
  });

  test('the fourth send to one number inside the window is refused', async ({
    request,
  }) => {
    const target = phone();

    for (let i = 0; i < SENDS_PER_NUMBER; i += 1) {
      const res = await sendOtp(request, customer.accessToken, otpBody(target));
      expect(res.status(), `send ${i + 1}: ${await res.text()}`).toBe(201);
    }

    const refused = await sendOtp(
      request,
      customer.accessToken,
      otpBody(target),
    );
    // A 400 rather than a 429: this ceiling is the service's own, not the
    // throttler's, and clients branch on the code.
    expect(refused.status(), await refused.text()).toBe(400);
    expect((await errorOf(refused)).code).toBe('RATE_LIMIT_EXCEEDED');

    expect((await otpRequestsFor(customer.id)).length).toBe(SENDS_PER_NUMBER);
    expect((await messagesFor(customer.id)).length).toBe(SENDS_PER_NUMBER);
  });

  test('a different number is unaffected by another number reaching the ceiling', async ({
    request,
  }) => {
    const burned = phone();
    for (let i = 0; i < SENDS_PER_NUMBER; i += 1) {
      await sendOtp(request, customer.accessToken, otpBody(burned));
    }
    expect(
      (await sendOtp(request, customer.accessToken, otpBody(burned))).status(),
    ).toBe(400);

    const fresh = await sendOtp(
      request,
      customer.accessToken,
      otpBody(phone()),
    );
    expect(
      fresh.status(),
      'one saturated number blocked sends to an unrelated number',
    ).toBe(201);
  });

  test('the ceiling follows the number, not the account', async ({
    request,
  }) => {
    // The counter is keyed on the handset alone, so a second customer inherits
    // whatever budget the first one spent. That protects the recipient from
    // being bombed via several accounts; it also means one customer can
    // exhaust another customer's ability to text that number.
    const target = phone();
    for (let i = 0; i < SENDS_PER_NUMBER; i += 1) {
      const res = await sendOtp(request, customer.accessToken, otpBody(target));
      expect(res.status(), await res.text()).toBe(201);
    }

    const other = await createCustomer(request);
    await onboardCustomer(other.id);

    const res = await sendOtp(request, other.accessToken, otpBody(target));
    expect(res.status(), await res.text()).toBe(400);
    expect((await errorOf(res)).code).toBe('RATE_LIMIT_EXCEEDED');
    expect((await messagesFor(other.id)).length).toBe(0);

    // …and that customer's own budget for a different number is intact.
    const elsewhere = await sendOtp(
      request,
      other.accessToken,
      otpBody(phone()),
    );
    expect(elsewhere.status(), await elsewhere.text()).toBe(201);
  });

  test('a send refused for a flat balance still spends the number budget', async ({
    request,
  }) => {
    // The counter is incremented before the wallet is looked at, and only the
    // provider-failure path decrements it. So three refusals that never sent
    // an SMS leave the number saturated: top up, and the first real attempt is
    // rate-limited. Reported as a defect; pinned here as it behaves today.
    const target = phone();
    await setBalance(customer.id, 0);

    for (let i = 0; i < SENDS_PER_NUMBER; i += 1) {
      const res = await sendOtp(request, customer.accessToken, otpBody(target));
      expect(res.status(), await res.text()).toBe(400);
      expect((await errorOf(res)).code).toBe('INSUFFICIENT_BALANCE');
    }

    await setBalance(customer.id, 100);
    const res = await sendOtp(request, customer.accessToken, otpBody(target));
    expect(res.status(), await res.text()).toBe(400);
    expect((await errorOf(res)).code).toBe('RATE_LIMIT_EXCEEDED');
    expect((await messagesFor(customer.id)).length).toBe(0);
  });

  test('a body rejected by validation does not spend the number budget', async ({
    request,
  }) => {
    // Validation runs in the pipe, ahead of the service, so a malformed body
    // never reaches the counter. Without this the ceiling would be trivially
    // drainable by anyone with a token and a bad payload.
    const target = phone();

    for (let i = 0; i < SENDS_PER_NUMBER; i += 1) {
      const res = await sendOtp(
        request,
        customer.accessToken,
        otpBody(target, '12'),
      );
      expect(res.status(), await res.text()).toBe(400);
      expect((await errorOf(res)).code).toBe('VALIDATION_ERROR');
    }

    for (let i = 0; i < SENDS_PER_NUMBER; i += 1) {
      const res = await sendOtp(request, customer.accessToken, otpBody(target));
      expect(
        res.status(),
        `send ${i + 1} after bad payloads: ${await res.text()}`,
      ).toBe(201);
    }
  });

  test('identical sends fired at once cannot beat the ceiling', async ({
    request,
  }) => {
    // INCR is atomic, so the ceiling should hold under a burst the way it does
    // under a sequence. A read-then-write limiter would let all six through.
    const target = phone();
    await setBalance(customer.id, 100);

    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        sendOtp(request, customer.accessToken, otpBody(target)),
      ),
    );

    const statuses = results.map((r) => r.status());
    expect(
      statuses.every((s) => s === 201 || s === 400),
      `unexpected statuses: ${statuses.join(',')}`,
    ).toBe(true);

    // INCR hands out 1..6 in some order to the six requests; exactly the three
    // that get a value <= 3 proceed, and the wallet is funded, so the count is
    // not merely bounded — it is exact.
    const accepted = statuses.filter((s) => s === 201).length;
    expect(accepted, `${accepted} concurrent sends were accepted`).toBe(
      SENDS_PER_NUMBER,
    );

    // Every acceptance is one message and no more — no send slipped through
    // without its row, and no refusal left one behind.
    expect((await messagesFor(customer.id)).length).toBe(accepted);
    expect((await otpRequestsFor(customer.id)).length).toBe(accepted);
  });

  test('the route throttle answers 429 past two hundred requests in ten seconds', async ({
    request,
  }) => {
    // @Throttle({ limit: 200, ttl: 10000 }) on the handler
    // (src/otp/otp.controller.ts:22) — six times tighter than the global
    // 1200/60s it overrides, on the one endpoint that spends provider money.
    // Nothing else in the suite would notice the decorator being deleted.
    //
    // Guards run before pipes, so a validation-failing body still counts
    // against the throttler while never reaching the service, the wallet, or
    // the provider. That is what makes 210+ requests affordable here.
    test.setTimeout(120_000);
    const target = phone();

    const statuses: number[] = [];
    const TOTAL = 210;
    const CHUNK = 30;
    for (let sent = 0; sent < TOTAL; sent += CHUNK) {
      const batch = await Promise.all(
        Array.from({ length: Math.min(CHUNK, TOTAL - sent) }, () =>
          sendOtp(request, customer.accessToken, otpBody(target, '12')),
        ),
      );
      statuses.push(...batch.map((r) => r.status()));
    }

    const count400 = statuses.filter((s) => s === 400).length;
    const count429 = statuses.filter((s) => s === 429).length;
    expect(
      statuses.every((s) => s === 400 || s === 429),
      `unexpected statuses: ${[...new Set(statuses)].join(',')}`,
    ).toBe(true);
    // At most 200 requests fit the window; everything past them must be
    // throttled. The exact split depends on wall clock, but a run with no 429
    // at all means the override is gone.
    expect(
      count429,
      `all ${TOTAL} requests were admitted — the 200/10s override is not in force`,
    ).toBeGreaterThanOrEqual(1);
    expect(count400).toBeLessThanOrEqual(200);

    // Neither the refused-by-validation requests nor the throttled ones may
    // have written anything.
    expect((await otpRequestsFor(customer.id)).length).toBe(0);
    expect((await messagesFor(customer.id)).length).toBe(0);
  });

  test('the ceiling lives in redis and is released when that store is cleared', async ({
    request,
  }) => {
    // Proves the counter is the Redis key with the five-minute TTL rather than
    // a count of rows or an in-process map — a test cannot wait out the window,
    // but it can clear the store the window lives in.
    const target = phone();
    for (let i = 0; i < SENDS_PER_NUMBER; i += 1) {
      await sendOtp(request, customer.accessToken, otpBody(target));
    }
    const refused = await sendOtp(
      request,
      customer.accessToken,
      otpBody(target),
    );
    expect((await errorOf(refused)).code).toBe('RATE_LIMIT_EXCEEDED');

    await flushRedis();

    const allowed = await sendOtp(
      request,
      customer.accessToken,
      otpBody(target),
    );
    expect(
      allowed.status(),
      'the ceiling survived a flush, so it is not the Redis counter',
    ).toBe(201);
    expect((await messagesFor(customer.id)).length).toBe(SENDS_PER_NUMBER + 1);
  });
});
