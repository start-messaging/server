import { Logger, MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { ThrottlerStorageRedisService } from '@nest-lab/throttler-storage-redis';
import Redis from 'ioredis';
import {
  bullPrefix,
  redisLogicalDb,
} from './common/constants/redis-keys.constants.js';
import { AppLoggerModule } from './common/logger/app-logger.module.js';
import { ConfigService } from '@nestjs/config';
import { AppConfigModule } from './config/config.module.js';
import { DatabaseModule } from './database/database.module.js';
import { HealthModule } from './health/health.module.js';
import { AuthModule } from './auth/auth.module.js';
import { UsersModule } from './users/users.module.js';
import { ApiKeysModule } from './api-keys/api-keys.module.js';
import { WalletModule } from './wallet/wallet.module.js';
import { PaymentsModule } from './payments/payments.module.js';
import { SmsProvidersModule } from './sms-providers/sms-providers.module.js';
import { MessagesModule } from './messages/messages.module.js';
import { OtpModule } from './otp/otp.module.js';
import { AdminModule } from './admin/admin.module.js';
import { AffiliateModule } from './affiliate/affiliate.module.js';
import { ChannelsModule } from './channels/channels.module.js';
import { CommonModule } from './common/common.module.js';
import { RedisModule } from './common/redis.module.js';
import { CorrelationIdMiddleware } from './common/middleware/correlation-id.middleware.js';
import { WebhooksModule } from './webhooks/webhooks.module.js';
import { OnboardingModule } from './onboarding/onboarding.module.js';
import { LeadsModule } from './leads/leads.module.js';
import { TelemetryModule } from './telemetry.module.js';
import { CombinedAuthGuard } from './auth/guards/combined-auth.guard.js';
import { JwtAuthGuard } from './auth/guards/jwt-auth.guard.js';
import { ApiKeyAuthGuard } from './auth/guards/api-key-auth.guard.js';
import { RolesGuard } from './common/guards/roles.guard.js';
import { OnboardingGuard } from './common/guards/onboarding.guard.js';

@Module({
  imports: [
    ThrottlerModule.forRootAsync({
      imports: [AppConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const redisUrl = config.get<string>('redis.url');
        const prefix = config.get<string>('redis.keyPrefix');

        // Given a prefix the storage takes a client rather than a URL, so the
        // rate-limit counters are namespaced too — without that, a load test
        // in one environment throttles real users in the other. Unprefixed it
        // keeps the URL form it has always used, so production is untouched.
        let storage: ThrottlerStorageRedisService | undefined;
        if (redisUrl) {
          storage = prefix
            ? new ThrottlerStorageRedisService(
                new Redis(redisUrl, { keyPrefix: `${prefix}:throttle:` }),
              )
            : new ThrottlerStorageRedisService(redisUrl);
        }

        return {
          throttlers: [{ name: 'default', ttl: 60000, limit: 1200 }], // Global broad limit (burstable)
          storage,
        };
      },
    }),
    BullModule.forRootAsync({
      imports: [AppConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const redisUrl = config.get<string>('redis.url');
        if (!redisUrl) throw new Error('REDIS_URL is required for BullMQ');

        // Parsing redis url: redis://[:password@]host[:port][/db]
        const url = new URL(redisUrl);
        const prefix = config.get<string>('redis.keyPrefix');

        // Both derived from one place: the e2e global setup sweeps this DB
        // and the leads helper enqueues into it, and a disagreement between
        // any two of the three means a job lands where no worker is reading.
        const db = redisLogicalDb(url);
        const queuePrefix = bullPrefix(prefix);

        // Nobody should have to reconstruct which Redis a queue lives on
        // again — the two values that decide it go out once, at boot.
        new Logger('BullMQ').log(
          `BullMQ queues on Redis db ${db}, key prefix "${queuePrefix}"`,
        );

        return {
          connection: {
            host: url.hostname,
            port: parseInt(url.port || '6379', 10),
            password: url.password || undefined,
            username: url.username || undefined,
            // This factory parsed the URL and threw the path away, so every
            // queue landed on db 0 whatever REDIS_URL said, while the
            // throttler and the shared ioredis client — both handed the URL
            // whole — sat on the db it names. A suite pointed at /14 flushed
            // /14 between tests and never touched the queues it thought it
            // was clearing, and a dev API on /3 shared bare `bull:*` keys on
            // db 0 with the e2e API on /14: the two stole each other's jobs,
            // which is what the intermittent "the webhook worker never moved
            // message X to delivered" timeouts were. Still the object form,
            // not the URL string — the string would let a rediss:// URL start
            // negotiating TLS on a connection that works without it today.
            db,
          },
          // BullMQ namespaces its own keys, so it takes `prefix` rather than
          // ioredis's keyPrefix — the latter would corrupt the Lua scripts it
          // uses to move jobs between states. Left at BullMQ's own default
          // when unset, so existing queues keep their names and in-flight
          // jobs are still found after a deploy.
          prefix: queuePrefix,
        };
      },
    }),
    AppLoggerModule,
    CommonModule,
    AppConfigModule,
    DatabaseModule,
    HealthModule,
    AuthModule,
    UsersModule,
    ApiKeysModule,
    WalletModule,
    PaymentsModule,
    SmsProvidersModule,
    MessagesModule,
    OtpModule,
    AdminModule,
    AffiliateModule,
    ChannelsModule,
    RedisModule,
    WebhooksModule,
    TelemetryModule,
    OnboardingModule,
    LeadsModule,
  ],
  providers: [
    JwtAuthGuard,
    ApiKeyAuthGuard,
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: CombinedAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
    { provide: APP_GUARD, useClass: OnboardingGuard },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(CorrelationIdMiddleware).forRoutes('*');
  }
}
