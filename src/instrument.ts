/**
 * Sentry bootstrap — the true first module of the process.
 *
 * Imported as the first line of telemetry.ts, which main.ts imports before
 * anything else, so the chain main.ts -> telemetry.ts -> instrument.ts keeps
 * Sentry.init ahead of every other import the way its docs require.
 */
// Must be first — loads .env before any env var below is read. This import
// used to live in telemetry.ts; it moved here because this file now runs
// even earlier.
import 'dotenv/config';

import * as Sentry from '@sentry/nestjs';

/**
 * PRODUCTION ONLY, and `SENTRY_ENVIRONMENT` has to say so in as many words —
 * there is deliberately no fallback to NODE_ENV.
 *
 * The reason is specific to how this system is deployed: staging runs with
 * NODE_ENV=production on purpose, because staging should behave like production
 * (STAGING.md). NODE_ENV therefore cannot tell the two boxes apart, and falling
 * back to it would arm Sentry on staging the moment a DSN reached that .env —
 * the one thing this gate exists to prevent. Requiring an explicit
 * `SENTRY_ENVIRONMENT=production` fails closed instead: a box that never
 * declares itself production reports nothing, whatever else is set.
 *
 * Failing closed has its own cost — a production box missing that single line is
 * silently unmonitored — so the reason is logged at boot by telemetry.ts rather
 * than left to be discovered when an incident is not reported.
 *
 * NODE_ENV=test is excluded on top of all of it because the e2e suite boots the
 * real server, and a developer with a real DSN in their shell must never have a
 * local test run post errors to the production project. SENTRY_ENABLED=false is
 * the operational kill switch that needs no DSN removal.
 */
const declaredEnvironment = process.env.SENTRY_ENVIRONMENT;

export const sentryEnabled =
  !!process.env.SENTRY_DSN &&
  declaredEnvironment === 'production' &&
  process.env.SENTRY_ENABLED !== 'false' &&
  process.env.NODE_ENV !== 'test';

/**
 * Why Sentry is off, for the boot log. Empty when it is on. Ordered so the
 * first genuinely-missing prerequisite is the one reported, rather than the
 * last one checked.
 */
export const sentryDisabledReason = sentryEnabled
  ? ''
  : !process.env.SENTRY_DSN
    ? 'SENTRY_DSN is not set'
    : process.env.SENTRY_ENABLED === 'false'
      ? 'SENTRY_ENABLED=false'
      : process.env.NODE_ENV === 'test'
        ? 'NODE_ENV=test'
        : `SENTRY_ENVIRONMENT is ${
            declaredEnvironment ? `'${declaredEnvironment}'` : 'unset'
          }, not 'production'`;

/**
 * Errors-only Sentry, composed with the existing OTel NodeSDK.
 *
 * skipOpenTelemetrySetup because telemetry.ts already owns the OTel NodeSDK
 * — a second global registration is the documented double-instrumentation
 * failure mode (duplicate TracerProvider/context manager). No
 * tracesSampleRate on purpose: with it unset, nothing ships spans to Sentry;
 * telemetry.ts wires the Sentry sampler/propagator/context manager into the
 * one SDK so errors still carry the right request's context.
 */
export const sentryClient = sentryEnabled
  ? Sentry.init({
      dsn: process.env.SENTRY_DSN,
      environment: declaredEnvironment,
      release: process.env.npm_package_version,
      skipOpenTelemetrySetup: true,
    })
  : undefined;

/**
 * Process-level safety net, registered here so it is in place before any other
 * module is even evaluated.
 *
 * AllExceptionsFilter only sees throws inside the HTTP pipeline. An unhandled
 * rejection in a BullMQ processor, a scheduled sweep, or any floating promise
 * bypasses it completely — and since Node 15 the default for an unhandled
 * rejection is to terminate the process. Before this existed such a death
 * recorded nothing anywhere: no filter ran, so no Sentry event and no OTEL log,
 * and pm2 restarted a process whose last words were a bare stack on stdout.
 *
 * The asymmetry between the two handlers is deliberate:
 *
 *   - `unhandledRejection` is recorded and the process is ALLOWED TO LIVE. That
 *     is a behaviour change — a rejection like this used to kill the API — and
 *     it is the right trade for a service that bills per message: dropping
 *     every in-flight OTP because one floating promise rejected is worse than
 *     carrying on with the fault recorded.
 *   - `uncaughtException` still exits. Registering a handler suppresses Node's
 *     own exit, and a process that has thrown past every frame is in an
 *     undefined state, so pm2 should restart it. The flush is awaited first
 *     because Sentry's transport is asynchronous and the event would otherwise
 *     be discarded in the queue as the process goes down.
 *
 * `console.error` rather than the Nest logger on purpose: neither Nest nor pino
 * exists yet when this module is evaluated, and pm2 captures stdout/stderr
 * either way.
 */
process.on('unhandledRejection', (reason: unknown) => {
  console.error('[process] unhandledRejection —', reason);
  if (sentryEnabled) {
    Sentry.captureException(reason, {
      tags: { handler: 'unhandledRejection' },
    });
  }
});

process.on('uncaughtException', (error: Error) => {
  console.error('[process] uncaughtException —', error);
  if (!sentryEnabled) {
    process.exit(1);
  }
  Sentry.captureException(error, { tags: { handler: 'uncaughtException' } });
  void Sentry.flush(2000).finally(() => process.exit(1));
});
