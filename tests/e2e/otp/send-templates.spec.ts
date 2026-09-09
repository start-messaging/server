import { test, expect } from '@playwright/test';
import { resetDb, closeDb, sql } from '../helpers/db.js';
import {
  createCustomer,
  onboardCustomer,
  unique,
  Customer,
} from '../helpers/actors.js';
import {
  FALLBACK_RENDERED,
  messagesFor,
  otpBody,
  phone,
  sendOtp,
} from './helpers.js';

/**
 * One seam of `POST /otp/send`: which template it renders.
 *
 * wallet/otp-billing covers the money path and the obvious rejections; this
 * file goes after what that one takes for granted.
 */

test.describe('OTP send: template resolution', () => {
  let customer: Customer;
  let channelId: string | null = null;
  const created: string[] = [];

  test.beforeEach(async ({ request }) => {
    await resetDb();
    customer = await createCustomer(request);
    await onboardCustomer(customer.id);

    const [channel] = await sql<{ id: string }>(
      `SELECT "id" FROM "channels" WHERE "deletedAt" IS NULL LIMIT 1`,
    );
    channelId = channel?.id ?? null;
  });

  test.afterEach(async () => {
    // Templates and channels are outside resetDb's truncation list, so a
    // fixture left behind would show up in every later /templates listing.
    // Soft-deleting keeps the messages foreign key valid while hiding the row
    // from every repository read.
    if (created.length) {
      await sql(
        `UPDATE "otp_templates" SET "deletedAt" = now() WHERE "id" = ANY($1::uuid[])`,
        [created],
      );
      created.length = 0;
    }
  });

  test.afterAll(async () => {
    await closeDb();
  });

  async function seedTemplate(body: string, status: 'draft' | 'published') {
    const [row] = await sql<{ id: string }>(
      `INSERT INTO "otp_templates" ("name", "body", "channelId", "status")
       VALUES ($1, $2, $3, $4) RETURNING "id"`,
      [unique('e2e-otp-tpl'), body, channelId, status],
    );
    created.push(row.id);
    return row.id;
  }

  test('a draft template is ignored and never claimed on the message', async ({
    request,
  }) => {
    test.skip(!channelId, 'no channel seeded in this environment');
    const templateId = await seedTemplate('Draft body {{otp}}', 'draft');

    const res = await sendOtp(
      request,
      customer.accessToken,
      otpBody(phone(), '123456', { templateId }),
    );
    expect(res.status(), await res.text()).toBe(201);

    const [message] = await messagesFor(customer.id);
    // The requested id is deliberately not recorded: the body that went out
    // was the fallback, and claiming the draft would misattribute the send.
    expect(message.otpTemplateId).toBeNull();
    expect(message.renderedContent).toBe(FALLBACK_RENDERED);
  });

  test('a published template is used and recorded', async ({ request }) => {
    test.skip(!channelId, 'no channel seeded in this environment');
    const templateId = await seedTemplate(
      'Code {{otp}} for {{appName}}',
      'published',
    );

    const res = await sendOtp(
      request,
      customer.accessToken,
      otpBody(phone(), '123456', { templateId }),
    );
    expect(res.status(), await res.text()).toBe(201);

    const [message] = await messagesFor(customer.id);
    expect(message.otpTemplateId).toBe(templateId);
    // What this test is about is that the *published* template was the one
    // resolved and recorded. `appName` was not supplied, so it renders from the
    // service default — the rendering rule itself is owned by the test below.
    expect(message.renderedContent).toBe('Code ****** for StartMessaging');
  });

  test('the fallback body renders its defaults instead of the word undefined', async ({
    request,
  }) => {
    // OtpVariablesDto declares `expiry?` and `appName?`, so those keys exist as
    // undefined on the transformed DTO whether or not the caller sent them.
    // They once won the spread in `{ ...defaults, ...variables }`, so the
    // correctly-computed defaults were thrown away and every OTP that omitted
    // `expiry` read "Valid for undefined minutes" — customer-facing text, on
    // the highest-volume message this product sends.
    //
    // renderOtpMessage now copies across only the keys that carry an actual
    // string before merging, so an omitted key cannot beat its default, and the
    // substitution loop refuses anything that is not a string outright. The
    // guarantee this pins: the word "undefined" can never reach a recipient.
    const res = await sendOtp(
      request,
      customer.accessToken,
      otpBody(phone(), '123456'),
    );
    expect(res.status(), await res.text()).toBe(201);

    const [message] = await messagesFor(customer.id);
    expect(message.renderedContent).toBe(FALLBACK_RENDERED);
  });

  test('a template variable the DTO does not declare never reaches the body', async ({
    request,
  }) => {
    // The pipe whitelists nested objects too, and OtpVariablesDto declares
    // only otp, appName and expiry — its index signature is erased at runtime
    // and carries no metadata. Anything else is stripped before the service
    // sees it, so a registered template with a custom variable goes out with
    // the placeholder still in it. Pinned as it behaves today and reported.
    test.skip(!channelId, 'no channel seeded in this environment');
    const templateId = await seedTemplate(
      'Hi {{name}}, your code is {{otp}}',
      'published',
    );

    const res = await sendOtp(request, customer.accessToken, {
      phoneNumber: phone(),
      variables: { otp: '123456', name: 'Vicky' },
      templateId,
    });
    expect(res.status(), await res.text()).toBe(201);

    const [message] = await messagesFor(customer.id);
    expect(message.otpTemplateId).toBe(templateId);
    expect(message.renderedContent).toBe('Hi {{name}}, your code is ******');
    expect(message.renderedContent).not.toContain('Vicky');
  });
});
