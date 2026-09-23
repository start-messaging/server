import { OTP_COST_INR } from '../otp/constants/otp.constant.js';

import { DEFAULT_CONVENIENCE_FEE } from '../payments/convenience-fee.js';
import { APP_NAME } from '../common/constants/app.constants.js';

export default () => ({
  port: parseInt(process.env.PORT ?? '3000', 10),
  database: {
    host: process.env.DATABASE_HOST,
    port: parseInt(process.env.DATABASE_PORT ?? '5432', 10),
    name: process.env.DATABASE_NAME,
    username: process.env.DATABASE_USERNAME,
    password: process.env.DATABASE_PASSWORD,
  },
  redis: {
    url: process.env.REDIS_URL,
    // Namespaces every key this instance writes. Empty in production, so its
    // keys keep the names they already have; staging sets it so that pointing
    // two environments at one Redis cannot make them share a queue.
    keyPrefix: process.env.REDIS_KEY_PREFIX ?? '',
  },
  auth: {
    bcryptRounds: parseInt(process.env.BCRYPT_ROUNDS ?? '10', 10),
  },
  jwt: {
    secret: process.env.JWT_SECRET,
    expiration: process.env.JWT_EXPIRATION ?? '15m',
  },
  /**
   * Affiliate portal signing key. Kept distinct from `jwt.secret` so a
   * customer token can never authenticate a partner route, and vice-versa.
   */
  partnerJwt: {
    secret: process.env.PARTNER_JWT_SECRET,
    expiration: process.env.PARTNER_JWT_EXPIRATION ?? '1h',
  },
  affiliate: {
    /** Where a referral link points — the customer-facing dashboard. */
    referralBaseUrl:
      process.env.AFFILIATE_REFERRAL_BASE_URL ??
      'https://app.startmessaging.com',
    /**
     * Whether this process registers the accrual/payout timers. Defaults on;
     * the e2e suite turns it off so a background accrual cannot fire mid-test.
     * Declared in Joi as a boolean, so a typo is caught rather than read as
     * "on" the way the old raw `!== 'false'` did.
     */
    schedulerEnabled: process.env.AFFILIATE_SCHEDULER_ENABLED !== 'false',
  },
  sms: {
    twoFactor: {
      apiKey: process.env.TWOFACTOR_API_KEY,
      templateName: process.env.TWOFACTOR_TEMPLATE_NAME || 'OTP',
      // DLT sender header, required by the transactional endpoint used for
      // multi-variable templates. Defaults to this account's approved header
      // so no env change is needed to fix the voice-call fallback; override
      // with TWOFACTOR_SENDER_ID for a different 2Factor account.
      senderId: process.env.TWOFACTOR_SENDER_ID || 'STMSG',
    },
    // Settles messages the provider never sent a webhook for. Every knob is
    // an env override so the sweep can be slowed, widened or switched off
    // without a deploy if it ever misbehaves against the provider's API.
    reconcile: {
      // Joi declares this a boolean defaulting true, so `FALSE`/`0`/`no`
      // are coerced (or rejected) there rather than silently ignored here —
      // the old `!== 'false'` treated every one of those as "on".
      enabled: process.env.SMS_RECONCILE_ENABLED !== 'false',
      intervalMinutes: Number(process.env.SMS_RECONCILE_INTERVAL_MINUTES ?? 5),
      graceMinutes: Number(process.env.SMS_RECONCILE_GRACE_MINUTES ?? 10),
      maxAgeHours: Number(process.env.SMS_RECONCILE_MAX_AGE_HOURS ?? 48),
      batchSize: Number(process.env.SMS_RECONCILE_BATCH_SIZE ?? 50),
    },
    console: {
      /** Log messages instead of sending them. Local development only. */
      enabled: process.env.SMS_CONSOLE_PROVIDER === 'true',
    },
  },
  /**
   * The "you haven't finished signing up" nudges.
   *
   * There is no switch. The sweep runs wherever this process is production AND
   * can actually deliver mail, which is production and nowhere else:
   *
   * - staging runs NODE_ENV=production on purpose (STAGING.md), so NODE_ENV
   *   alone cannot tell the two boxes apart — staging is kept out by having no
   *   Mailgun key, which STAGING.md lists as deliberate;
   * - a laptop runs NODE_ENV=development, whatever database `.env` names;
   * - the e2e suites run NODE_ENV=test.
   *
   * This replaced ONBOARDING_REMINDERS_ENABLED on 2026-09-14. That flag
   * defaulted off and was never set on the production box, so not one reminder
   * had ever been sent, and the admin Signups screen was the first thing to say
   * so. The one combination that now emails customers from the wrong place is a
   * local API run with NODE_ENV=production and a real Mailgun key against a
   * database holding real addresses — never run that.
   */
  onboardingReminders: {
    enabled:
      process.env.NODE_ENV === 'production' &&
      !!process.env.MAILGUN_API_KEY &&
      !!process.env.MAILGUN_DOMAIN,
    /**
     * Log who would be emailed and send nothing. Claims no rows, so a rehearsal
     * leaves every account exactly as eligible as it found it.
     */
    dryRun: process.env.ONBOARDING_REMINDERS_DRY_RUN === 'true',
    // maxPerRun moved to src/onboarding/constants/onboarding-reminders.constant.ts
  },
  /**
   * Cold-outreach transport and tracking. Deliberately NOT the Mailgun
   * credentials above: cold mail on the product domain risks the account every
   * password-reset depends on, so outreach points at a separate lookalike
   * domain's SMTP inbox.
   */
  outreach: {
    smtp: {
      host: process.env.OUTREACH_SMTP_HOST,
      port: Number(process.env.OUTREACH_SMTP_PORT ?? 587),
      user: process.env.OUTREACH_SMTP_USER,
      pass: process.env.OUTREACH_SMTP_PASS,
      secure: process.env.OUTREACH_SMTP_SECURE === 'true',
    },
    fromName: process.env.OUTREACH_FROM_NAME ?? APP_NAME,
    fromEmail: process.env.OUTREACH_FROM_EMAIL,
    replyTo: process.env.OUTREACH_REPLY_TO,
    /** Log instead of sending. Local/test only, same idiom as SMS_CONSOLE_PROVIDER. */
    consoleProvider: process.env.OUTREACH_CONSOLE_PROVIDER === 'true',
    /**
     * Deliverability protection, not a business rule: a new outreach domain
     * that suddenly sends hundreds a day gets junk-foldered, which burns the
     * domain for good. Counted in Asia/Kolkata days.
     */
    dailyCap: Number(process.env.OUTREACH_DAILY_CAP ?? 100),
    /** Where tracking pixel/click/unsubscribe URLs point — this API. */
    publicBaseUrl:
      process.env.OUTREACH_PUBLIC_BASE_URL ?? 'https://api.startmessaging.com',
    /**
     * The CTA target. Carries ?smref=<leadId> so PostHog on the marketing site
     * attributes the visit to the lead.
     */
    linkBaseUrl:
      process.env.OUTREACH_LINK_BASE_URL ?? 'https://startmessaging.com',
    /**
     * CAN-SPAM requires a physical postal address in the footer of commercial
     * mail. Rendered only when set — an empty default keeps local sends from
     * printing a placeholder as if it were an address.
     */
    postalAddress: process.env.OUTREACH_POSTAL_ADDRESS ?? '',
    // clickHosts moved to src/leads/outreach/outreach.constant.ts — it is a
    // security allowlist, not a setting.
  },
  mailgun: {
    apiKey: process.env.MAILGUN_API_KEY,
    domain: process.env.MAILGUN_DOMAIN,
    fromName: process.env.MAILGUN_FROM_NAME ?? APP_NAME,
    fromEmail: process.env.MAILGUN_FROM_EMAIL,
    replyToEmail: process.env.MAILGUN_REPLY_TO_EMAIL,
  },
  payments: {
    razorpay: {
      keyId: process.env.RAZORPAY_KEY_ID,
      keySecret: process.env.RAZORPAY_KEY_SECRET,
      webhookSecret: process.env.RAZORPAY_WEBHOOK_SECRET,
    },
    /**
     * The customer pays the gateway's cut. Always — this is what a top-up
     * costs, not a mode the deployment can be in.
     *
     * The rate is overridable so it can follow the gateway's pricing without a
     * deploy, but it defaults to Razorpay's published 2%, so an environment
     * that sets nothing is already correct.
     *
     * `simple` adds the percentage to what the customer asked for, which is a
     * round number they can check. `gross_up` charges whatever nets the top-up
     * exactly, which is precise but not a total anyone can verify in their
     * head.
     *
     * NOTE: UPI carries zero MDR in India and merchants are not permitted to
     * levy a charge on it. The payment method is not known when the order is
     * created — the customer picks it afterwards, inside Razorpay Checkout —
     * so this surcharge necessarily applies to UPI as well. Charging per
     * method would mean asking for it before the order exists.
     */
    convenienceFee: {
      mode: (process.env.CONVENIENCE_FEE_MODE ??
        DEFAULT_CONVENIENCE_FEE.mode) as 'simple' | 'gross_up',
      percent: Number(
        process.env.CONVENIENCE_FEE_PERCENT ?? DEFAULT_CONVENIENCE_FEE.percent,
      ),
      gstPercent: Number(
        process.env.CONVENIENCE_FEE_GST_PERCENT ??
          DEFAULT_CONVENIENCE_FEE.gstPercent,
      ),
    },
    /**
     * Test seam: replace ORDER CREATION with a local fake. The gateway
     * factory additionally requires NODE_ENV === 'test' — a fake gateway
     * reachable in production would mint top-ups for free.
     */
    fakeGateway: process.env.PAYMENTS_FAKE_GATEWAY === 'true',
  },
  google: {
    clientId: process.env.GOOGLE_CLIENT_ID,
    /**
     * Test seam: accept `mock:<base64url JSON>` id tokens instead of calling
     * Google. AuthService additionally requires NODE_ENV === 'test' — an
     * unsigned identity assertion honoured anywhere near production is an
     * account-takeover primitive.
     */
    mockVerify: process.env.GOOGLE_MOCK_VERIFY === 'true',
  },
  r2: {
    accountId: process.env.R2_ACCOUNT_ID,
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    bucketName: process.env.R2_BUCKET_NAME,
    publicUrl: process.env.R2_PUBLIC_URL,
    /**
     * Any S3-compatible endpoint (minio, localstack, a test fixture). Unset =
     * Cloudflare R2 derived from the account id, exactly as before.
     */
    endpoint: process.env.R2_ENDPOINT,
  },
  cors: {
    origins: process.env.CORS_ORIGINS
      ? process.env.CORS_ORIGINS.split(',').map((s) => s.trim())
      : [
          'https://app.startmessaging.com',
          'https://admin.startmessaging.com',
          // The partner portal. Without it here, every request from the portal
          // is blocked by the browser on any deploy that does not set
          // CORS_ORIGINS explicitly — and CORS_ORIGINS is optional.
          // Both spellings are listed because the repo is inconsistent about
          // which one is the real host (the Worker is named `partners`, while
          // .env.example referred to `partner.`). Set CORS_ORIGINS explicitly
          // at deploy and neither default is used; until then, allowing an
          // extra origin you own is harmless and a missing one is an outage.
          'https://partners.startmessaging.com',
          'https://partner.startmessaging.com',
          'http://localhost:5173',
          'http://localhost:5174',
          'http://localhost:5175',
        ],
  },
  // otp expiry and cost moved to src/otp/constants/otp.constant.ts
  currencies: {
    supported: ['INR'],
    default: 'INR',
    config: {
      INR: {
        gateway: 'razorpay',
        minTopUp: 1000,
        otpCost: OTP_COST_INR,
        locale: 'en-IN',
      },
    },
  },
});
