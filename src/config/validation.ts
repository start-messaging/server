import Joi from 'joi';

export const envValidationSchema = Joi.object({
  /**
   * Constrained rather than free-form, because a dozen places branch on
   * `NODE_ENV === 'production'` and every one of them fails *open* on a value
   * that is merely close: `prod`, `Production` or an unset variable silently
   * turns off the secure flag on the partner and referral cookies, downgrades
   * the console-SMS boot alarm to a warning, and re-enables query logging.
   * Refusing an unknown value at boot is the only place this can be caught.
   */
  NODE_ENV: Joi.string()
    .valid('development', 'test', 'production')
    .default('development'),

  PORT: Joi.number().default(3000),

  // Database
  DATABASE_HOST: Joi.string().required(),
  DATABASE_PORT: Joi.number().default(5432),
  DATABASE_NAME: Joi.string().required(),
  DATABASE_USERNAME: Joi.string().required(),
  DATABASE_PASSWORD: Joi.string().required(),

  // Auth
  BCRYPT_ROUNDS: Joi.number().min(4).max(20).default(10),

  // JWT
  JWT_SECRET: Joi.string().required(),
  JWT_EXPIRATION: Joi.string().default('15m'),
  JWT_REFRESH_EXPIRATION: Joi.string().default('7d'),

  // Affiliate partner portal. The secret must differ from JWT_SECRET so a
  // customer token can never authenticate a partner route; sharing one would
  // silently collapse that boundary.
  PARTNER_JWT_SECRET: Joi.string()
    .required()
    .invalid(Joi.ref('JWT_SECRET'))
    .messages({
      'any.invalid':
        'PARTNER_JWT_SECRET must not be the same value as JWT_SECRET',
    }),
  PARTNER_JWT_EXPIRATION: Joi.string().default('1h'),
  AFFILIATE_REFERRAL_BASE_URL: Joi.string().uri().optional(),

  // CORS
  CORS_ORIGINS: Joi.string().optional(),

  // Fast2SMS
  FAST2SMS_API_KEY: Joi.string().optional(),
  FAST2SMS_ROUTE: Joi.string().valid('otp', 'q', 'dlt').default('dlt'),
  FAST2SMS_SENDER_ID: Joi.string().optional(),
  FAST2SMS_DLT_TEMPLATE_ID: Joi.string().optional(),

  // Razorpay (optional)
  RAZORPAY_KEY_ID: Joi.string().optional(),
  RAZORPAY_KEY_SECRET: Joi.string().optional(),
  RAZORPAY_WEBHOOK_SECRET: Joi.string().optional(),

  // The customer always pays the gateway's cut; these only tune the rate, and
  // all three have working defaults. Capped well below anything defensible: a
  // fat-fingered 20 instead of 2 would quietly overcharge every top-up.
  CONVENIENCE_FEE_MODE: Joi.string()
    .valid('simple', 'gross_up')
    .default('simple'),
  CONVENIENCE_FEE_PERCENT: Joi.number().min(0).max(10).default(2),
  CONVENIENCE_FEE_GST_PERCENT: Joi.number().min(0).max(30).default(18),

  // Google OAuth
  GOOGLE_CLIENT_ID: Joi.string().optional(),

  // Cloudflare R2
  R2_ACCOUNT_ID: Joi.string().optional(),
  R2_ACCESS_KEY_ID: Joi.string().optional(),
  R2_SECRET_ACCESS_KEY: Joi.string().optional(),
  R2_BUCKET_NAME: Joi.string().optional(),
  R2_PUBLIC_URL: Joi.string().optional(),

  // OTP
  OTP_EXPIRY_MINUTES: Joi.number().default(5),
  OTP_COST: Joi.number().default(0.25),

  // Redis
  // Overrides the default (SSL on in production). Set false to reach a local
  // Postgres that has no TLS while still running as NODE_ENV=production.
  DATABASE_SSL: Joi.boolean().optional(),

  REDIS_URL: Joi.string().optional(),
  // Colons are the separator, so a prefix containing one would nest
  // unpredictably; letters, digits, dashes and underscores only.
  REDIS_KEY_PREFIX: Joi.string()
    .pattern(/^[A-Za-z0-9_-]*$/)
    .allow('')
    .default(''),

  // Mailgun
  MAILGUN_API_KEY: Joi.string().optional(),
  MAILGUN_DOMAIN: Joi.string().optional(),
  MAILGUN_FROM_NAME: Joi.string().default('StartMessaging'),
  MAILGUN_FROM_EMAIL: Joi.string().optional(),
  MAILGUN_REPLY_TO_EMAIL: Joi.string().email().optional(),

  // Outreach campaigns
  //
  // Every field is optional and the transport defaults to `console`, so an
  // environment that never runs a campaign needs no new configuration. The
  // conditional requirements below only bite once a real transport is chosen —
  // which is the moment a missing credential would otherwise surface as a
  // half-sent campaign rather than a refused boot.
  CAMPAIGN_TRANSPORT: Joi.string()
    .valid('console', 'smtp', 'brevo', 'mailgun')
    .default('console'),
  CAMPAIGN_FROM_NAME: Joi.string().default('StartMessaging'),
  CAMPAIGN_FROM_EMAIL: Joi.string()
    .email()
    .when('CAMPAIGN_TRANSPORT', {
      is: 'console',
      then: Joi.optional(),
      otherwise: Joi.required(),
    }),
  CAMPAIGN_REPLY_TO: Joi.string().email().optional(),
  CAMPAIGN_COMPANY_ADDRESS: Joi.string().max(300).optional(),

  // Tracking links live in mail that outlives any single deploy, so the base
  // URL must be an absolute, publicly reachable origin.
  CAMPAIGN_TRACKING_BASE_URL: Joi.string()
    .uri({ scheme: ['http', 'https'] })
    .when('CAMPAIGN_TRANSPORT', {
      is: 'console',
      then: Joi.optional(),
      otherwise: Joi.required(),
    }),
  CAMPAIGN_TRACKING_SECRET: Joi.string()
    .min(32)
    .when('CAMPAIGN_TRANSPORT', {
      is: 'console',
      then: Joi.optional(),
      otherwise: Joi.required(),
    })
    .messages({
      'string.min':
        'CAMPAIGN_TRACKING_SECRET must be at least 32 characters — it signs unsubscribe links.',
    }),

  CAMPAIGN_SEND_RATE_PER_MINUTE: Joi.number().integer().min(1).default(30),
  CAMPAIGN_DAILY_SEND_CAP: Joi.number().integer().min(1).default(250),

  CAMPAIGN_SMTP_HOST: Joi.string().when('CAMPAIGN_TRANSPORT', {
    is: 'smtp',
    then: Joi.required(),
    otherwise: Joi.optional(),
  }),
  CAMPAIGN_SMTP_PORT: Joi.number().port().default(587),
  CAMPAIGN_SMTP_USER: Joi.string().when('CAMPAIGN_TRANSPORT', {
    is: 'smtp',
    then: Joi.required(),
    otherwise: Joi.optional(),
  }),
  CAMPAIGN_SMTP_PASS: Joi.string().when('CAMPAIGN_TRANSPORT', {
    is: 'smtp',
    then: Joi.required(),
    otherwise: Joi.optional(),
  }),
  CAMPAIGN_SMTP_SECURE: Joi.boolean().default(false),

  CAMPAIGN_BREVO_API_KEY: Joi.string().when('CAMPAIGN_TRANSPORT', {
    is: 'brevo',
    then: Joi.required(),
    otherwise: Joi.optional(),
  }),

  // Custom testing
  MOCK_SMS_SEND: Joi.boolean().default(false),

  /**
   * Enables the console SMS provider, which logs messages instead of sending
   * them. Intended for local development, where no real provider credentials
   * are configured. Never enable in production — sends would silently succeed
   * without reaching anyone.
   */
  SMS_CONSOLE_PROVIDER: Joi.boolean().default(false),
});
