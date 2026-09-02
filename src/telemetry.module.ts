import { Module, OnModuleDestroy, Logger } from '@nestjs/common';
import * as Sentry from '@sentry/nestjs';
import { shutdownTelemetry } from './telemetry.js';
import { sentryEnabled } from './instrument.js';

@Module({})
export class TelemetryModule implements OnModuleDestroy {
  private readonly logger = new Logger(TelemetryModule.name);

  async onModuleDestroy() {
    this.logger.log('Flushing and shutting down OTEL SDK…');
    await shutdownTelemetry();
    // Flush pending error envelopes before pm2 replaces the process — an
    // error captured in the last seconds of a deploy would otherwise die in
    // the SDK's buffer.
    if (sentryEnabled) {
      await Sentry.close(2000);
    }
  }
}
