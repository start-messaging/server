import { Module, OnModuleDestroy, Logger } from '@nestjs/common';
import { shutdownTelemetry } from './telemetry.js';

@Module({})
export class TelemetryModule implements OnModuleDestroy {
  private readonly logger = new Logger(TelemetryModule.name);

  async onModuleDestroy() {
    this.logger.log('Flushing and shutting down OTEL SDK…');
    await shutdownTelemetry();
  }
}
