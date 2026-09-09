/**
 * Sentry bootstrap — the true first module of the process.
 *
 * Imported as the first line of telemetry.ts, which main.ts imports before
 * anything else, so the chain main.ts → telemetry.ts → instrument.ts keeps
 * Sentry.init ahead of every other import the way its docs require.
 */
// Must be first — loads .env before any env var below is read. This import
// used to live in telemetry.ts; it moved here because this file now runs
// even earlier.
import 'dotenv/config';

import * as Sentry from '@sentry/nestjs';

/**
 * NODE_ENV=test is excluded on top of the DSN check because the e2e suite
 * boots the real server, and a developer with a real DSN in their shell must
 * never have a local test run post errors to the production project —
 * .env.e2e already documents this exact contract. SENTRY_ENABLED=false is
 * the operational kill switch that needs no DSN removal.
 */
export const sentryEnabled =
  !!process.env.SENTRY_DSN &&
  process.env.SENTRY_ENABLED !== 'false' &&
  process.env.NODE_ENV !== 'test';

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
      environment:
        process.env.SENTRY_ENVIRONMENT ??
        process.env.NODE_ENV ??
        'development',
      release: process.env.npm_package_version,
      skipOpenTelemetrySetup: true,
    })
  : undefined;
