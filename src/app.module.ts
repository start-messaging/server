import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { LoggerModule } from 'nestjs-pino';
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
import { ChannelsModule } from './channels/channels.module.js';
import { CommonModule } from './common/common.module.js';
import { CorrelationIdMiddleware } from './common/middleware/correlation-id.middleware.js';
import { CombinedAuthGuard } from './auth/guards/combined-auth.guard.js';
import { JwtAuthGuard } from './auth/guards/jwt-auth.guard.js';
import { ApiKeyAuthGuard } from './auth/guards/api-key-auth.guard.js';
import { RolesGuard } from './common/guards/roles.guard.js';
import { OnboardingGuard } from './common/guards/onboarding.guard.js';

@Module({
  imports: [
    ThrottlerModule.forRoot([{ ttl: 60000, limit: 60 }]),
    LoggerModule.forRoot({
      pinoHttp: {
        transport:
          process.env.NODE_ENV !== 'production'
            ? { target: 'pino-pretty', options: { singleLine: true } }
            : undefined,
        autoLogging: true,
        serializers: {
          req: (req) => ({
            method: req.method,
            url: req.url,
          }),
          res: (res) => ({
            statusCode: res.statusCode,
          }),
        },
        redact: ['req.headers.authorization', 'req.headers["x-api-key"]'],
      },
    }),
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
    ChannelsModule,
  ],
  providers: [
    JwtAuthGuard,
    ApiKeyAuthGuard,
    { provide: APP_GUARD, useClass: CombinedAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
    { provide: APP_GUARD, useClass: OnboardingGuard },
    { provide: APP_GUARD, useClass: ThrottlerGuard },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(CorrelationIdMiddleware).forRoutes('*');
  }
}
