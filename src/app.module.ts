import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { ThrottlerStorageRedisService } from '@nest-lab/throttler-storage-redis';
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
        return {
          throttlers: [{ name: 'default', ttl: 60000, limit: 1200 }], // Global broad limit (burstable)
          storage: redisUrl
            ? new ThrottlerStorageRedisService(redisUrl)
            : undefined,
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
        return {
          connection: {
            host: url.hostname,
            port: parseInt(url.port || '6379', 10),
            password: url.password || undefined,
            username: url.username || undefined,
          },
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
