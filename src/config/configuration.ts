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
  payments: {
    razorpay: {
      keyId: process.env.RAZORPAY_KEY_ID,
      keySecret: process.env.RAZORPAY_KEY_SECRET,
      webhookSecret: process.env.RAZORPAY_WEBHOOK_SECRET,
    },
    /**
     * Passes the gateway's cut on to the customer instead of absorbing it.
     *
     * OFF by default, deliberately. This changes what every customer is
     * charged, so it must be switched on knowingly rather than arriving with a
     * deploy.
     *
     * Razorpay's published rate is 2% across domestic cards, UPI, netbanking
     * and wallets, with GST charged on that fee.
     *
     * NOTE: UPI carries zero MDR in India and merchants are not permitted to
     * levy a charge on it. The payment method is not known when the order is
     * created — the customer picks it afterwards, inside Razorpay Checkout —
     * so a surcharge configured here necessarily applies to UPI as well.
     * Charging per method would mean asking for it before the order exists.
     */
    convenienceFee: {
      enabled: process.env.CONVENIENCE_FEE_ENABLED === 'true',
      // `simple` adds the percentage to what the customer asked for, which is
      // a round number they can check. `gross_up` charges whatever nets the
      // top-up exactly, which is precise but unmemorable.
      mode: (process.env.CONVENIENCE_FEE_MODE ?? 'simple') as
        | 'simple'
        | 'gross_up',
      percent: Number(process.env.CONVENIENCE_FEE_PERCENT ?? 2),
      gstPercent: Number(process.env.CONVENIENCE_FEE_GST_PERCENT ?? 18),
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
