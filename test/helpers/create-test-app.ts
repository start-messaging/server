import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ThrottlerStorage } from '@nestjs/throttler';
import { AppModule } from '../../src/app.module.js';
import { applyGlobalConfig } from '../../src/config/apply-global-config.js';

export interface TestAppContext {
  app: INestApplication;
  close: () => Promise<void>;
}

// A throttler storage that never reports over-limit — disables rate limiting
// for e2e specs (the global ThrottlerGuard is an APP_GUARD useClass, which
// overrideGuard can't reliably replace, so we neutralise the storage instead).
const noopThrottlerStorage: ThrottlerStorage = {
  increment: () =>
    Promise.resolve({
      totalHits: 0,
      timeToExpire: 0,
      isBlocked: false,
      timeToBlockExpire: 0,
    }),
};

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
    .overrideProvider(ThrottlerStorage)
    .useValue(noopThrottlerStorage)
    .compile();

  const app = moduleRef.createNestApplication({ bufferLogs: true });
  applyGlobalConfig(app);
  await app.init();

  return { app, close: () => app.close() };
}
