import { Injectable, Logger, OnApplicationShutdown } from '@nestjs/common';
import { PostHog } from 'posthog-node';

export interface PostHogCapture {
  distinctId: string;
  event: string;
  properties?: Record<string, unknown>;
}

/**
 * Product analytics events (distinct from the OTEL log export in telemetry.ts,
 * which ships request/error logs to PostHog's logs product).
 *
 * Reads POSTHOG_API_KEY / POSTHOG_HOST straight off process.env, the same way
 * telemetry.ts does — configuration.ts has no posthog namespace, and adding
 * one for a second reader would leave the two halves of the PostHog wiring
 * configured through different doors.
 */
@Injectable()
export class PostHogService implements OnApplicationShutdown {
  private readonly logger = new Logger(PostHogService.name);
  private readonly client: PostHog | null;

  constructor() {
    const apiKey = process.env.POSTHOG_API_KEY;
    const host = process.env.POSTHOG_HOST ?? 'https://us.i.posthog.com';

    // Test runs boot the real application; a developer with a real key in
    // their shell must not have a test run write into production analytics.
    this.client =
      apiKey && process.env.NODE_ENV !== 'test'
        ? new PostHog(apiKey, { host })
        : null;
  }

  /** No-ops when unconfigured and never throws — analytics must never break a request. */
  capture(input: PostHogCapture): void {
    if (!this.client) return;
    try {
      this.client.capture({
        distinctId: input.distinctId,
        event: input.event,
        properties: input.properties,
      });
    } catch (err) {
      this.logger.warn(
        `PostHog capture failed for "${input.event}": ${(err as Error).message}`,
      );
    }
  }

  /**
   * posthog-node batches events in memory; without this flush the last events
   * of a deploy die with the process pm2 is replacing.
   */
  async onApplicationShutdown(): Promise<void> {
    await this.client?.shutdown();
  }
}
