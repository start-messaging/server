/**
 * OpenTelemetry SDK bootstrap — must be imported before any other module.
 *
 * Follows PostHog docs exactly:
 * https://posthog.com/docs/logs/installation/nodejs
 */
// Must be first — loads .env before reading POSTHOG_API_KEY
import 'dotenv/config';

import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-http';
import { BatchLogRecordProcessor } from '@opentelemetry/sdk-logs';
import { resourceFromAttributes } from '@opentelemetry/resources';

const apiKey = process.env.POSTHOG_API_KEY;
const host = process.env.POSTHOG_HOST ?? 'https://us.i.posthog.com';

let sdk: NodeSDK | null = null;

if (apiKey) {
  sdk = new NodeSDK({
    resource: resourceFromAttributes({
      'service.name': 'start-messaging-server',
      'service.version': process.env.npm_package_version ?? '0.0.1',
      'deployment.environment': process.env.NODE_ENV ?? 'development',
    }),
    logRecordProcessor: new BatchLogRecordProcessor(
      new OTLPLogExporter({
        url: `${host}/i/v1/logs`,
        headers: {
          Authorization: `Bearer ${apiKey}`,
        },
      }),
    ),
  });

  sdk.start();
  console.log(
    '[telemetry] OTEL SDK started — logs will be exported to PostHog',
  );
}

export async function shutdownTelemetry(): Promise<void> {
  if (sdk) await sdk.shutdown();
}
