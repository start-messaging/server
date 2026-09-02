/**
 * OpenTelemetry SDK bootstrap — must be imported before any other module.
 *
 * Follows PostHog docs exactly:
 * https://posthog.com/docs/logs/installation/nodejs
 */
// Must be first — runs Sentry.init (and the dotenv load) before anything
// else, including the OTel imports below.
import './instrument.js';

import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-http';
import { BatchLogRecordProcessor } from '@opentelemetry/sdk-logs';
import { resourceFromAttributes } from '@opentelemetry/resources';
import * as Sentry from '@sentry/nestjs';
import { SentryPropagator, SentrySampler } from '@sentry/opentelemetry';
import { sentryClient } from './instrument.js';

const apiKey = process.env.POSTHOG_API_KEY;
const host = process.env.POSTHOG_HOST ?? 'https://us.i.posthog.com';

let sdk: NodeSDK | null = null;

if (apiKey || sentryClient) {
  sdk = new NodeSDK({
    resource: resourceFromAttributes({
      'service.name': 'start-messaging-server',
      'service.version': process.env.npm_package_version ?? '0.0.1',
      'deployment.environment': process.env.NODE_ENV ?? 'development',
    }),
    ...(apiKey
      ? {
          logRecordProcessor: new BatchLogRecordProcessor(
            new OTLPLogExporter({
              url: `${host}/i/v1/logs`,
              headers: {
                Authorization: `Bearer ${apiKey}`,
              },
            }),
          ),
        }
      : {}),
    // Sentry's docs require these three even in error-only mode: they keep
    // each captured error tagged with the right request's scope/trace context
    // under concurrency. With no tracesSampleRate configured the sampler
    // ships nothing to Sentry — no SentrySpanProcessor is registered, so the
    // PostHog log pipeline above is the only exporter this SDK owns.
    ...(sentryClient
      ? {
          sampler: new SentrySampler(sentryClient),
          textMapPropagator: new SentryPropagator(),
          contextManager: new Sentry.SentryContextManager(),
        }
      : {}),
  });

  sdk.start();
  if (sentryClient) {
    Sentry.validateOpenTelemetrySetup();
  }
  console.log(
    `[telemetry] OTEL SDK started —` +
      `${apiKey ? ' logs will be exported to PostHog;' : ''}` +
      `${sentryClient ? ' Sentry error capture is active' : ''}`,
  );
}

export async function shutdownTelemetry(): Promise<void> {
  if (sdk) await sdk.shutdown();
}
