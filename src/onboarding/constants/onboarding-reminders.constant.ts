/**
 * Tuning for the onboarding reminder sweep.
 *
 * This was ONBOARDING_REMINDERS_MAX_PER_RUN. It is a safety backstop rather
 * than a deployment setting: no environment wanted its own ceiling, and the
 * number only ever needs to change if the shape of the sweep changes, which is
 * a code change anyway.
 *
 * The sweep's on/off and dry-run switches are NOT here — see
 * `configuration.ts`. They are the one part of this feature that genuinely
 * differs per environment, because `server/.env` points at the production
 * database and a developer booting the API locally must not start emailing
 * live customers.
 */

/**
 * Ceiling on sends per sweep, per stage.
 *
 * A backstop against a bad query or a backfilled `createdAt` turning one run
 * into a mass mailing. The sweep runs hourly and the windows are 24 hours
 * wide, so an ordinary day's signups clear comfortably under it.
 */
export const REMINDERS_MAX_PER_RUN = 200;
