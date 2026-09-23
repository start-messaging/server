import Joi from 'joi';

import { APP_NAME } from '../common/constants/app.constants.js';

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
  /**
   * From here on, every genuinely-optional string carries `.allow('')` (or
   * `.empty('')` where a default should take over). `.env.example` is meant to
   * be COPYABLE — `cp .env.example .env` has to boot — and the template
   * documents optional keys by listing them with no value. Joi rejects the
   * empty string for `Joi.string()` by default, so every one of those blank
   * lines was a boot failure naming a key the developer was never asked to
   * fill in. An empty optional string means "not configured", which is how the
   * readers in `configuration.ts` already treat it: they branch on truthiness
   * (`origins: X ? ... : defaults`, `if (keyId && keySecret)`) or coerce with
   * `?? ''`. Keys read through `??` instead — where '' would survive as a real
   * value and defeat the fallback — use `.empty('')`, so a blank line leaves
   * the variable genuinely unset. Anything REQUIRED stays required and SHOULD
   * still fail when blank; the template ships placeholders for those.
   */
  AFFILIATE_REFERRAL_BASE_URL: Joi.string().uri().empty('').optional(),
  /**
   * Whether this process registers the accrual/payout timers. Declared so a
   * typo fails at boot: the reader used to be a raw
   * `process.env.X !== 'false'`, which quietly treated `FALSE`, `0` and `no`
   * as ON — the one direction you never want a sweep that moves money to
   * default to by accident.
   */
  AFFILIATE_SCHEDULER_ENABLED: Joi.boolean().empty('').default(true),

  // CORS
  CORS_ORIGINS: Joi.string().allow('').optional(),

  // Fast2SMS

  // Razorpay (optional)
  RAZORPAY_KEY_ID: Joi.string().allow('').optional(),
  RAZORPAY_KEY_SECRET: Joi.string().allow('').optional(),
  RAZORPAY_WEBHOOK_SECRET: Joi.string().allow('').optional(),

  /**
   * Test seam, same idiom as SMS_CONSOLE_PROVIDER: default off, and the
   * gateway factory ALSO requires NODE_ENV === 'test' before honouring it.
   * Swaps only ORDER CREATION for a local fake so the e2e suite can drive
   * /payments/create-order to a persisted row without calling Razorpay's live
   * orders API; signature and webhook verification stay the real HMAC code.
   * Double-locked because a fake gateway reachable in production would mint
   * top-ups for free.
   */
  PAYMENTS_FAKE_GATEWAY: Joi.boolean().default(false),

  // The customer always pays the gateway's cut; these only tune the rate, and
  // all three have working defaults. Capped well below anything defensible: a
  // fat-fingered 20 instead of 2 would quietly overcharge every top-up.
  CONVENIENCE_FEE_MODE: Joi.string()
    .valid('simple', 'gross_up')
    .default('simple'),
  CONVENIENCE_FEE_PERCENT: Joi.number().min(0).max(10).default(2),
  CONVENIENCE_FEE_GST_PERCENT: Joi.number().min(0).max(30).default(18),

  // Google OAuth
  GOOGLE_CLIENT_ID: Joi.string().allow('').optional(),

  /**
   * Test seam for Google sign-in, same idiom as SMS_CONSOLE_PROVIDER: default
   * off, and the service ALSO requires NODE_ENV === 'test' before honouring
   * it. Live verification needs Google's public keys and a real client id, so
   * the signup/link paths were untestable; the flag lets the e2e suite present
   * `mock:<base64url JSON>` id tokens instead. Double-locked because a server
   * that accepts unsigned identity assertions is an account-takeover
   * primitive — any email named in the payload becomes a session.
   */
  GOOGLE_MOCK_VERIFY: Joi.boolean().default(false),

  // Cloudflare R2
  R2_ACCOUNT_ID: Joi.string().allow('').optional(),
  R2_ACCESS_KEY_ID: Joi.string().allow('').optional(),
  R2_SECRET_ACCESS_KEY: Joi.string().allow('').optional(),
  R2_BUCKET_NAME: Joi.string().allow('').optional(),
  R2_PUBLIC_URL: Joi.string().allow('').optional(),
  // Any S3-compatible endpoint (minio, localstack, a test fixture). Unset =
  // Cloudflare R2, derived from R2_ACCOUNT_ID as always. Not test-locked: it
  // is a generic storage knob, and without credentials it can do nothing.
  R2_ENDPOINT: Joi.string().uri().allow('').optional(),

  // OTP

  // Redis
  // Overrides the default (SSL on in production). Set false to reach a local
  // Postgres that has no TLS while still running as NODE_ENV=production.
  DATABASE_SSL: Joi.boolean().optional(),

  REDIS_URL: Joi.string().allow('').optional(),
  // Colons are the separator, so a prefix containing one would nest
  // unpredictably; letters, digits, dashes and underscores only.
  REDIS_KEY_PREFIX: Joi.string()
    .pattern(/^[A-Za-z0-9_-]*$/)
    .allow('')
    .default(''),

  // Mailgun
  MAILGUN_API_KEY: Joi.string().allow('').optional(),
  MAILGUN_DOMAIN: Joi.string().allow('').optional(),
  // `.empty('')` rather than `.allow('')`: both readers fall back with `??`
  // (`configuration.ts` and `email.service.ts`), which '' would survive,
  // putting a blank From name on every message instead of APP_NAME.
  MAILGUN_FROM_NAME: Joi.string().empty('').default(APP_NAME),
  MAILGUN_FROM_EMAIL: Joi.string().allow('').optional(),
  MAILGUN_REPLY_TO_EMAIL: Joi.string().email().allow('').optional(),

  // Onboarding reminders
  //
  // Deliberately no on/off switch: the sweep runs wherever NODE_ENV is
  // production and Mailgun is configured (configuration.ts says why that means
  // production only). DRY_RUN is the one knob — a rehearsal that logs every
  // intended recipient and sends nothing. A leftover
  // ONBOARDING_REMINDERS_ENABLED line in a box's .env is ignored, not refused.
  ONBOARDING_REMINDERS_DRY_RUN: Joi.boolean().default(false),

  // Custom testing
  MOCK_SMS_SEND: Joi.boolean().default(false),

  /**
   * Enables the console SMS provider, which logs messages instead of sending
   * them. Intended for local development, where no real provider credentials
   * are configured. Never enable in production — sends would silently succeed
   * without reaching anyone.
   */
  SMS_CONSOLE_PROVIDER: Joi.boolean().default(false),

  /**
   * Previously undeclared, and therefore unvalidated, because
   * `config.module.ts` sets `allowUnknown: true`. TWOFACTOR_API_KEY is the
   * credential for the only registered SMS provider — it had no rule at all
   * while the dead FAST2SMS keys had four.
   */
  TWOFACTOR_API_KEY: Joi.string().allow('').optional(),
  TWOFACTOR_TEMPLATE_NAME: Joi.string().allow('').default('OTP'),
  TWOFACTOR_SENDER_ID: Joi.string().allow('').default('STMSG'),

  /**
   * Webhook-miss settlement sweep. Defaults ON, and the same `!== 'false'`
   * trap as AFFILIATE_SCHEDULER_ENABLED applied here: declaring it a boolean
   * makes Joi coerce or reject the value rather than reading a typo as "on".
   */
  SMS_RECONCILE_ENABLED: Joi.boolean().empty('').default(true),
  SMS_RECONCILE_INTERVAL_MINUTES: Joi.number().empty('').integer().min(1).default(5),
  SMS_RECONCILE_GRACE_MINUTES: Joi.number().empty('').integer().min(1).default(10),
  SMS_RECONCILE_MAX_AGE_HOURS: Joi.number().empty('').integer().min(1).default(48),
  SMS_RECONCILE_BATCH_SIZE: Joi.number().empty('').integer().min(1).default(50),

  /**
   * Telemetry. Read in `instrument.ts` and `telemetry.ts` before Nest exists,
   * so they are consumed as raw `process.env` — declaring them here does not
   * change that, it just means a malformed value is caught at boot.
   * SENTRY_ENABLED is an operational off-switch that leaves the DSN in place.
   */
  SENTRY_DSN: Joi.string().allow('').optional(),
  SENTRY_ENABLED: Joi.boolean().empty('').default(true),
  /**
   * Constrained, because instrument.ts arms Sentry only when this is exactly
   * 'production'. A typo — `Production`, `prod` — is therefore not a mistake
   * anyone notices; it is error reporting silently switched off on the one box
   * that needs it. Refusing an unknown value at boot is the only place that can
   * be caught.
   */
  SENTRY_ENVIRONMENT: Joi.string()
    .valid('production', 'staging', 'development')
    .empty('')
    .optional(),
  POSTHOG_API_KEY: Joi.string().allow('').optional(),
  POSTHOG_HOST: Joi.string().uri().empty('').default('https://us.i.posthog.com'),
});
