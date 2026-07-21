import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ThrottlerGuard } from '@nestjs/throttler';
import { AppModule } from '../../src/app.module.js';
import { applyGlobalConfig } from '../../src/config/apply-global-config.js';

export interface TestAppContext {
  app: INestApplication;
  close: () => Promise<void>;
}

/**
 * The ONE bootstrap for e2e specs. Imports the real AppModule and applies the
 * same global pipe/interceptor/filter wiring as production via
 * `applyGlobalConfig` — specs never re-instantiate the module or re-wire config.
 */
export async function createTestApp(): Promise<TestAppContext> {
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
  })
    // Rate limiting is irrelevant to (and would flake) e2e specs.
    .overrideGuard(ThrottlerGuard)
    .useValue({ canActivate: () => true })
    .compile();

  const app = moduleRef.createNestApplication({ bufferLogs: true });
  applyGlobalConfig(app);
  await app.init();

  return { app, close: () => app.close() };
}
