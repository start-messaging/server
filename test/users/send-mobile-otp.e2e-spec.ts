import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from '../helpers/create-test-app';
import { unwrap, errorCode } from '../helpers/envelope';
import { registerUser, bearer, uniqueMobileIN } from '../helpers/auth';

// POST /users/send-mobile-otp — @SkipOnboarding(); default POST status is 201.
// SMS_DRIVER is pinned to 'console' in the test env (set-test-env.ts), so the
// send resolves without hitting a real gateway. The console provider only
// simulates failure for the sentinel code 000000, which randomInt(100000,
// 999999) can never produce — so the happy path is deterministic.
describe('POST /users/send-mobile-otp', () => {
  let app: INestApplication;

  beforeAll(async () => {
    ({ app } = await createTestApp());
  });

  afterAll(async () => {
    await app.close();
  });

  it('sends an OTP to a valid Indian mobile number', async () => {
    const user = await registerUser(app, 'otpsend');
    const res = await request(app.getHttpServer())
      .post('/users/send-mobile-otp')
      .set('Authorization', bearer(user.accessToken))
      .send({ mobileNumber: uniqueMobileIN() })
      .expect(201);

    const data = unwrap<{ sent: boolean; message: string }>(res.body);
    expect(data.sent).toBe(true);
  });

  it('rejects an unauthenticated request with 401', async () => {
    await request(app.getHttpServer())
      .post('/users/send-mobile-otp')
      .send({ mobileNumber: uniqueMobileIN() })
      .expect(401);
  });

  it('rejects an invalid mobile number with 400 VALIDATION_ERROR', async () => {
    const user = await registerUser(app, 'otpsend');
    const res = await request(app.getHttpServer())
      .post('/users/send-mobile-otp')
      .set('Authorization', bearer(user.accessToken))
      .send({ mobileNumber: '12345' })
      .expect(400);
    expect(errorCode(res.body)).toBe('VALIDATION_ERROR');
  });
});
