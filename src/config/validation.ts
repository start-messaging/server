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
  AFFILIATE_REFERRAL_BASE_URL: Joi.string().uri().optional(),
  /**
   * Whether this process registers the accrual/payout timers. Declared so a
   * typo fails at boot: the reader used to be a raw
   * `process.env.X !== 'false'`, which quietly treated `FALSE`, `0` and `no`
   * as ON — the one direction you never want a sweep that moves money to
   * default to by accident.
   */
  AFFILIATE_SCHEDULER_ENABLED: Joi.boolean().empty('').default(true),

  // CORS
  CORS_ORIGINS: Joi.string().optional(),

  // Fast2SMS

  // Razorpay (optional)
  RAZORPAY_KEY_ID: Joi.string().optional(),
  RAZORPAY_KEY_SECRET: Joi.string().optional(),
  RAZORPAY_WEBHOOK_SECRET: Joi.string().optional(),

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
  GOOGLE_CLIENT_ID: Joi.string().optional(),

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
  R2_ACCOUNT_ID: Joi.string().optional(),
  R2_ACCESS_KEY_ID: Joi.string().optional(),
  R2_SECRET_ACCESS_KEY: Joi.string().optional(),
  R2_BUCKET_NAME: Joi.string().optional(),
  R2_PUBLIC_URL: Joi.string().optional(),
  // Any S3-compatible endpoint (minio, localstack, a test fixture). Unset =
  // Cloudflare R2, derived from R2_ACCOUNT_ID as always. Not test-locked: it
  // is a generic storage knob, and without credentials it can do nothing.
  R2_ENDPOINT: Joi.string().uri().optional(),

  // OTP

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
  MAILGUN_FROM_NAME: Joi.string().default(APP_NAME),
  MAILGUN_FROM_EMAIL: Joi.string().optional(),
  MAILGUN_REPLY_TO_EMAIL: Joi.string().email().optional(),

  // Onboarding reminders
  //
  // Off unless explicitly switched on. An environment that has never heard of
  // these variables sends nothing, which is what a developer pointed at a copy
  // of production data needs the default to be.
  ONBOARDING_REMINDERS_ENABLED: Joi.boolean().default(false),
  ONBOARDING_REMINDERS_DRY_RUN: Joi.boolean().default(false),

  // Leads: NRD ingest + enrichment crawler. Both sweeps default off — they
  // fetch external sites and write thousands of rows, so nothing may start
  // crawling on boot. The ingest gate has no env var at all: it is operated
  // from the admin panel (lead_pipeline_settings.ingestEnabled) and defaults
  // to off in code, so there is nothing here to keep in step with it.
  // Not Joi.string().uri(): the {dateBase64Zip}/{date} placeholders are not
  // legal URI characters, so a uri() rule would reject every valid template.
  LEADS_NRD_URL_TEMPLATE: Joi.string().default(
    'https://www.whoisds.com/whois-database/newly-registered-domains/{dateBase64Zip}/nrd',
  ),
  // The curated lists (Indian/generic/blocked TLDs, keywords, India tokens)
  // are not here: they are data, not deployment config, and live in
  // src/leads/nrd/tld-lists.constant.ts where review and the filter's own
  // spec can both see them.
  // 200k (was 20k): with ingest-all on generic TLDs, ~100–150k keeps/day is
  // the new normal. The cap is a poisoned-file backstop — the ingest
  // priority-sorts before cutting, so a cut discards the low-value tail.
  // Tier-0 liveness prober has no env vars: its gate is
  // lead_pipeline_settings.livenessEnabled and its tuning is in
  // src/leads/liveness/liveness-tuning.constant.ts.
  // Enrichment knobs are DEFAULTS for the runtime lead_pipeline_settings
  // row, which the panel edits and which wins wherever set.
  LEADS_ENRICH_ENABLED: Joi.boolean().default(false),
  // Leads claimed per drain slice; the drain loops until nothing claims.
  LEADS_ENRICH_BATCH_PER_SWEEP: Joi.number().integer().min(1).default(500),
  // Sites crawled at once inside the drain.
  LEADS_ENRICH_CONCURRENCY: Joi.number().integer().min(1).max(20).default(4),
  // Re-crawl window: crawled leads re-enter the drain after this many hours.
  LEADS_ENRICH_RECRAWL_HOURS: Joi.number().integer().min(1).default(48),
  // Test seam: fixtures replace the scheme+host, not the code.
  LEADS_ENRICH_URL_TEMPLATE: Joi.string().default('https://{domain}'),
  // The parking-NS list, the crawl timeouts, attempt counts, the per-run
  // valve and the parked-recheck window are not env vars: they are in
  // src/leads/enrichment/enrich-tuning.constant.ts.
  // The headless-browser escalation tier. Off by default — a headless
  // Chromium on the small production box would starve the API; it is meant
  // for a laptop/VPS worker pointed at the same database and Redis.
  LEADS_BROWSER_ENRICH_ENABLED: Joi.boolean().default(false),
  // 'chrome' = the machine's installed Google Chrome (no download); '' = the
  // playwright registry Chromium from `npx playwright install chromium`.
  LEADS_BROWSER_CHANNEL: Joi.string().allow('').default('chrome'),
  LEADS_BROWSER_EXECUTABLE_PATH: Joi.string().optional(),

  // Cold outreach. A separate lookalike domain's SMTP inbox, never the
  // product Mailgun — see the outreach namespace in configuration.ts.
  OUTREACH_SMTP_HOST: Joi.string().optional(),
  OUTREACH_SMTP_PORT: Joi.number().default(587),
  OUTREACH_SMTP_USER: Joi.string().optional(),
  OUTREACH_SMTP_PASS: Joi.string().optional(),
  OUTREACH_SMTP_SECURE: Joi.boolean().default(false),
  OUTREACH_FROM_NAME: Joi.string().default(APP_NAME),
  OUTREACH_FROM_EMAIL: Joi.string().email().optional(),
  OUTREACH_REPLY_TO: Joi.string().email().optional(),
  OUTREACH_CONSOLE_PROVIDER: Joi.boolean().default(false),
  OUTREACH_DAILY_CAP: Joi.number().integer().min(1).default(100),
  OUTREACH_PUBLIC_BASE_URL: Joi.string()
    .uri()
    .default('https://api.startmessaging.com'),
  OUTREACH_LINK_BASE_URL: Joi.string()
    .uri()
    .default('https://startmessaging.com'),
  OUTREACH_POSTAL_ADDRESS: Joi.string().allow('').default(''),
  // The click-redirect allowlist is not an env var — it is a security
  // allowlist, and lives in src/leads/outreach/outreach.constant.ts.

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
  SENTRY_ENVIRONMENT: Joi.string().allow('').optional(),
  POSTHOG_API_KEY: Joi.string().allow('').optional(),
  POSTHOG_HOST: Joi.string().uri().empty('').default('https://us.i.posthog.com'),
});
