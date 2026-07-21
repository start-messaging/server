import { INestApplication, ValidationPipe } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import { TransformResponseInterceptor } from '../common/interceptors/transform-response.interceptor.js';
import { AllExceptionsFilter } from '../common/filters/all-exceptions.filter.js';

/**
 * The ONE place that wires the request/response cross-cutting config shared by
 * production (`main.ts`) and the e2e harness (`createTestApp`): cookie parsing,
 * the global validation pipe, the success-envelope interceptor, and the
 * exception filter. Keeping this in one function means specs exercise the exact
 * same pipeline as prod.
 */
export function applyGlobalConfig(app: INestApplication): void {
  app.use(cookieParser());

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
    }),
  );

  app.useGlobalInterceptors(new TransformResponseInterceptor());
  app.useGlobalFilters(new AllExceptionsFilter());
}
