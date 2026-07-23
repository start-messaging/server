import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from '../helpers/create-test-app';
import { unwrap } from '../helpers/envelope';
import { registerUser, onboardUser, bearer } from '../helpers/auth';

// GET /users/kyc — @SkipOnboarding(); default GET status is 200. Returns the
// caller's own KYC detail projection (UsersService.getKycDetails).
describe('GET /users/kyc', () => {
  let app: INestApplication;

  beforeAll(async () => {
    ({ app } = await createTestApp());
  });

  afterAll(async () => {
    await app.close();
  });

  it('returns not_submitted KYC details for a fresh user', async () => {
    const user = await registerUser(app, 'kycget');
    const res = await request(app.getHttpServer())
      .get('/users/kyc')
      .set('Authorization', bearer(user.accessToken))
      .expect(200);

    const data = unwrap<{ kycStatus: string; businessName: string | null }>(
      res.body,
    );
    expect(data.kycStatus).toBe('not_submitted');
    expect(data.businessName).toBeNull();
  });

  it('reflects an approved KYC status once onboarded', async () => {
    const user = await registerUser(app, 'kycget');
    await onboardUser(app, user.id);
    const res = await request(app.getHttpServer())
      .get('/users/kyc')
      .set('Authorization', bearer(user.accessToken))
      .expect(200);

    const data = unwrap<{ kycStatus: string }>(res.body);
    expect(data.kycStatus).toBe('approved');
  });

  it('rejects an unauthenticated request with 401', async () => {
    await request(app.getHttpServer()).get('/users/kyc').expect(401);
  });
});
