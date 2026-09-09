import { test, expect } from '@playwright/test';
import { closeDb } from '../helpers/db.js';
import { KEY_SECRET, WEBHOOK_SECRET } from './helpers.js';

/**
 * The signing secrets the rest of the `/payments` specs are built on.
 *
 * Verification and the webhook need no network at all: both are plain HMACs
 * over a secret this suite already knows (.env.e2e), so a real signature can
 * be produced here and the whole settlement path — including the money —
 * exercised for real against seeded payment rows. All of which depends on the
 * secrets actually being present, which is what this file is for.
 */

test.describe('payments: the signing secrets this file depends on', () => {
  test.afterAll(async () => {
    await closeDb();
  });

  test('the test environment carries the dummy gateway credentials', () => {
    // Every signature in payments/checkout-verification.spec.ts and
    // payments/razorpay-webhook.spec.ts is computed from these. Without them
    // those files would still pass — by producing invalid signatures and
    // asserting that invalid signatures are refused — which is a green suite
    // testing nothing.
    expect(KEY_SECRET, 'RAZORPAY_KEY_SECRET is not set').toBeTruthy();
    expect(WEBHOOK_SECRET, 'RAZORPAY_WEBHOOK_SECRET is not set').toBeTruthy();
    expect(KEY_SECRET).not.toBe(WEBHOOK_SECRET);
  });
});
