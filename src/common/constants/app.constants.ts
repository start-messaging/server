export const API_KEY_PREFIX = 'sm_live_';

/**
 * Where an internal notification sends a reviewer.
 *
 * A constant rather than an environment variable on purpose. The only mail that
 * uses it is admin-facing, and staging cannot send mail at all — it ships no
 * MAILGUN_API_KEY (STAGING.md), so `sendEmail` returns early there and no
 * message is ever attempted. This address is therefore correct everywhere the
 * link can actually be delivered, and a new variable would add one more thing
 * that can sit unset while nothing appears to be wrong.
 */
export const ADMIN_PANEL_URL = 'https://admin.startmessaging.com';
export const REFRESH_TOKEN_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/**
 * The brand name in customer-facing copy — OTP message bodies, and the default
 * From name on transactional and outreach mail.
 *
 * Was `config.get('app.name') || 'StartMessaging'` in otp.service.ts, a lookup
 * that could never resolve: no `app.name` path and no APP_NAME variable has
 * ever existed, so every caller took the literal. A constant says that plainly
 * instead of implying a setting that isn't there.
 *
 * MAILGUN_FROM_NAME and OUTREACH_FROM_NAME still override the From name per
 * deployment — this is only what they fall back to.
 */
export const APP_NAME = 'StartMessaging';
