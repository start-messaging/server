import './telemetry.js';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import { Logger } from 'nestjs-pino';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import { AppModule } from './app.module.js';
import { TransformResponseInterceptor } from './common/interceptors/transform-response.interceptor.js';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter.js';
import { LoggingInterceptor } from './common/interceptors/logging.interceptor.js';

async function bootstrap() {
  // `rawBody` keeps the exact bytes of each request alongside the parsed body.
  // The Razorpay webhook needs them: an HMAC is over bytes, and re-serializing
  // the parsed object with JSON.stringify is not guaranteed to reproduce what
  // the sender signed. See RazorpayGateway.verifyWebhook.
  const app = await NestFactory.create(AppModule, {
    bufferLogs: true,
    rawBody: true,
  });
  app.enableShutdownHooks();
  // Trust the loopback proxy only — nginx, on this same box — and nothing else.
  //
  // This was `true`, which trusts every proxy in the chain, and that made
  // `req.ip` whatever the caller put in the leftmost `X-Forwarded-For` entry.
  // Two things ride on `req.ip`, and both were therefore writable by the
  // person they were meant to constrain:
  //
  //   - the API key's IP allow list (ApiKeyAuthGuard). A customer who locks a
  //     key to their office egress had no containment at all: a leaked key
  //     plus `-H 'X-Forwarded-For: <allowed>'` reached the API from anywhere,
  //     and the OTP was relayed and billed to their wallet.
  //   - the throttler's bucket, so per-IP limits on /auth/login and
  //     /auth/register were defeated by rotating the header.
  //
  // `'loopback'` rather than a hop count of 1 because it says the actual
  // topology: nginx terminates TLS on this machine and proxies to us over
  // 127.0.0.1, and there is no CDN in front of it (confirmed 2026-09-02).
  // Express then walks X-Forwarded-For from the right, skipping trusted
  // addresses, and stops at the first it does not trust — the client as nginx
  // saw it. Anything a caller prepends themselves sits to the left of that and
  // is ignored. It also fails safe if the topology changes: a request that
  // arrives from somewhere other than loopback has its header disbelieved
  // entirely rather than trusted.
  //
  // This depends on nginx sending the header at all. It must keep
  // `proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;` on both
  // server blocks — without it every caller resolves to 127.0.0.1 and the
  // per-IP throttles would fire against all customers at once. If a CDN is
  // ever put in front of nginx, this has to become that CDN's trusted range.
  // eslint-disable-next-line @typescript-eslint/no-unsafe-call
  app.getHttpAdapter().getInstance().set('trust proxy', 'loopback');
  const configService = app.get(ConfigService);

  app.useLogger(app.get(Logger));
  app.use(helmet());
  app.use(cookieParser());
  app.enableCors({
    origin: configService.get<string[]>('cors.origins'),
    credentials: true,
  });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
    }),
  );

  app.useGlobalInterceptors(
    new TransformResponseInterceptor(),
    new LoggingInterceptor(),
  );
  app.useGlobalFilters(new AllExceptionsFilter());

  const swaggerConfig = new DocumentBuilder()
    .setTitle('StartMessaging API')
    .setDescription('SaaS messaging platform API for sending OTPs')
    .setVersion('1.0')
    .addBearerAuth()
    .addApiKey({ type: 'apiKey', name: 'X-API-Key', in: 'header' }, 'api-key')
    .build();

  const document = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup('api/docs', app, document);

  const port = process.env.PORT ?? 3000;
  await app.listen(port);
}
void bootstrap();
