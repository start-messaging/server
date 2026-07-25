import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from '../helpers/create-test-app';
import { errorCode } from '../helpers/envelope';
import { registerUser, bearer } from '../helpers/auth';

// POST /users/verify-mobile-otp — @SkipOnboarding(); default POST status is 201.
//
// NOTE: the verify HAPPY PATH is intentionally NOT asserted here. The OTP is
// generated with crypto.randomInt() and persisted only as a bcrypt hash (see
// UsersService.generateMobileOtp) — it is never returned in the send response
// nor recoverable from the DB, so no deterministic 6-digit value exists for a
// test to submit. The send step is covered in send-mobile-otp.e2e-spec.ts.
// Here we cover auth, DTO validation, and the "no OTP on record" 400 branch.
describe('POST /users/verify-mobile-otp', () => {
  let app: INestApplication;

  beforeAll(async () => {
    ({ app } = await createTestApp());
  });

  afterAll(async () => {
    await app.close();
  });

  it('rejects an unauthenticated request with 401', async () => {
    await request(app.getHttpServer())
      .post('/users/verify-mobile-otp')
      .send({ otp: '123456' })
      .expect(401);
  });

  it('rejects an OTP that is not 6 digits with 400 VALIDATION_ERROR', async () => {
    const user = await registerUser(app, 'otpverify');
    const res = await request(app.getHttpServer())
      .post('/users/verify-mobile-otp')
      .set('Authorization', bearer(user.accessToken))
      .send({ otp: '123' })
      .expect(400);
    expect(errorCode(res.body)).toBe('VALIDATION_ERROR');
  });

  it('rejects verification when no OTP was requested (400)', async () => {
    const user = await registerUser(app, 'otpverify');
    const res = await request(app.getHttpServer())
      .post('/users/verify-mobile-otp')
      .set('Authorization', bearer(user.accessToken))
      .send({ otp: '654321' })
      .expect(400);
    expect(res.body.error.message).toMatch(/No valid OTP/i);
  });
});
