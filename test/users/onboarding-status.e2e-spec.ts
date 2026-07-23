import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from '../helpers/create-test-app';
import { unwrap } from '../helpers/envelope';
import { registerUser, onboardUser, bearer } from '../helpers/auth';

// GET /users/onboarding-status — @SkipOnboarding(); default GET status is 200.
describe('GET /users/onboarding-status', () => {
  let app: INestApplication;

  beforeAll(async () => {
    ({ app } = await createTestApp());
  });

  afterAll(async () => {
    await app.close();
  });

  it('reports step 1 (mobile verification) for a fresh, un-onboarded user', async () => {
    const user = await registerUser(app, 'onb');
    const res = await request(app.getHttpServer())
      .get('/users/onboarding-status')
      .set('Authorization', bearer(user.accessToken))
      .expect(200);

    const data = unwrap<{
      currentStep: number;
      isComplete: boolean;
      steps: Array<{ step: number; title: string; completed: boolean }>;
    }>(res.body);
    expect(data.currentStep).toBe(1);
    expect(data.isComplete).toBe(false);
    expect(data.steps).toHaveLength(3);
  });

  it('reports completion once the user is fully onboarded (KYC approved)', async () => {
    const user = await registerUser(app, 'onb');
    await onboardUser(app, user.id);
    const res = await request(app.getHttpServer())
      .get('/users/onboarding-status')
      .set('Authorization', bearer(user.accessToken))
      .expect(200);

    const data = unwrap<{ currentStep: number; isComplete: boolean }>(res.body);
    expect(data.isComplete).toBe(true);
    expect(data.currentStep).toBe(3);
  });

  it('rejects an unauthenticated request with 401', async () => {
    await request(app.getHttpServer())
      .get('/users/onboarding-status')
      .expect(401);
  });
});
