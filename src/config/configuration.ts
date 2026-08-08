import { DEFAULT_CONVENIENCE_FEE } from '../payments/convenience-fee.js';

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
    refreshExpiration: process.env.JWT_REFRESH_EXPIRATION ?? '7d',
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
  },
  sms: {
    fast2sms: {
      apiKey: process.env.FAST2SMS_API_KEY,
      route: process.env.FAST2SMS_ROUTE ?? 'dlt',
      senderId: process.env.FAST2SMS_SENDER_ID,
      dltTemplateId: process.env.FAST2SMS_DLT_TEMPLATE_ID,
    },
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
  mailgun: {
    apiKey: process.env.MAILGUN_API_KEY,
    domain: process.env.MAILGUN_DOMAIN,
    fromName: process.env.MAILGUN_FROM_NAME ?? 'StartMessaging',
    fromEmail: process.env.MAILGUN_FROM_EMAIL,
    replyToEmail: process.env.MAILGUN_REPLY_TO_EMAIL,
  },
  /**
   * Outbound marketing / outreach campaigns.
   *
   * Deliberately its own config tree rather than an extension of `mailgun`.
   * Campaign mail should leave by a different door from transactional mail —
   * different sending domain, different credentials, often a different vendor
   * entirely — because a complaint-driven reputation hit on outreach must not
   * be able to stop a customer receiving their OTP or KYC result.
   */
  campaigns: {
    /**
     * Which transport carries campaign mail.
     *
     * `console` is the default so a fresh environment cannot email real people
     * before anyone has consciously configured a sender.
     */
    transport: process.env.CAMPAIGN_TRANSPORT ?? 'console',

    fromName: process.env.CAMPAIGN_FROM_NAME ?? 'StartMessaging',
    fromEmail: process.env.CAMPAIGN_FROM_EMAIL,
    /** Outreach gets answered — replies should reach a human, not no-reply. */
    replyTo: process.env.CAMPAIGN_REPLY_TO,

    /**
     * Postal address printed in the footer of every campaign.
     *
     * Commercial email is required to carry one under CAN-SPAM, and filters
     * treat its absence as a spam signal. Left blank the footer simply omits
     * it, so a development environment needs no value.
     */
    companyAddress: process.env.CAMPAIGN_COMPANY_ADDRESS,

    /**
     * Public origin of THIS server, used to build tracking and unsubscribe
     * links. It has to be reachable by the recipient's mail client, so it
     * cannot be inferred from the request that created the campaign.
     */
    trackingBaseUrl: process.env.CAMPAIGN_TRACKING_BASE_URL,

    /**
     * Signs pixel, click and unsubscribe tokens.
     *
     * Kept apart from `jwt.secret` so a leaked tracking link can never be
     * escalated into a session, and so this can be rotated without logging
     * every customer out. Rotating it only invalidates the links inside
     * already-delivered emails.
     */
    trackingSecret: process.env.CAMPAIGN_TRACKING_SECRET,

    /**
     * Ceiling on sends per minute, applied by the BullMQ worker.
     *
     * Free relays and personal mailboxes throttle hard and count a rejected
     * message against you; pacing below the provider's limit is what keeps a
     * campaign from tripping it a third of the way through.
     */
    sendRatePerMinute: Number(process.env.CAMPAIGN_SEND_RATE_PER_MINUTE ?? 30),

    /**
     * Hard stop on messages sent across all campaigns in a rolling 24h.
     *
     * Matches whatever the chosen transport's free daily allowance is, so a
     * mistyped audience filter costs a paused campaign rather than a suspended
     * sending account.
     */
    dailySendCap: Number(process.env.CAMPAIGN_DAILY_SEND_CAP ?? 250),

    /** Any SMTP relay: Brevo, Zoho, Gmail/Workspace, SES, Mailjet, … */
    smtp: {
      host: process.env.CAMPAIGN_SMTP_HOST,
      port: Number(process.env.CAMPAIGN_SMTP_PORT ?? 587),
      user: process.env.CAMPAIGN_SMTP_USER,
      pass: process.env.CAMPAIGN_SMTP_PASS,
      /** Implicit TLS (port 465). Port 587 upgrades with STARTTLS instead. */
      secure: process.env.CAMPAIGN_SMTP_SECURE === 'true',
    },

    /** Brevo's HTTP send API — same credentials as their SMTP relay. */
    brevo: {
      apiKey: process.env.CAMPAIGN_BREVO_API_KEY,
    },
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
  },
  google: {
    clientId: process.env.GOOGLE_CLIENT_ID,
  },
  r2: {
    accountId: process.env.R2_ACCOUNT_ID,
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    bucketName: process.env.R2_BUCKET_NAME,
    publicUrl: process.env.R2_PUBLIC_URL,
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
  otp: {
    expiryMinutes: parseInt(process.env.OTP_EXPIRY_MINUTES ?? '5', 10),
    costPerOtp: parseFloat(process.env.OTP_COST ?? '0.25'),
  },
  currencies: {
    supported: ['INR'],
    default: 'INR',
    config: {
      INR: {
        gateway: 'razorpay',
        minTopUp: 1000,
        otpCost: parseFloat(process.env.OTP_COST ?? '0.25'),
        locale: 'en-IN',
      },
    },
  },
});
