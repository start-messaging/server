import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from '../helpers/create-test-app';
import { unwrap, errorCode } from '../helpers/envelope';
import {
  registerUser,
  onboardUser,
  bearer,
  uniqueMobileIN,
} from '../helpers/auth';
import { WalletService } from '../../src/wallet/wallet.service';

describe('POST /otp/send', () => {
  let app: INestApplication;

  beforeAll(async () => {
    ({ app } = await createTestApp());
  });

  afterAll(async () => {
    await app.close();
  });

  it('sends an OTP for an onboarded user with the ₹10 welcome credit', async () => {
    const user = await registerUser(app, 'otp');
    await onboardUser(app, user.id);

    const res = await request(app.getHttpServer())
      .post('/otp/send')
      .set('Authorization', bearer(user.accessToken))
      .send({ phoneNumber: uniqueMobileIN(), variables: { otp: '123456' } })
      .expect(201);

    const data = unwrap<{
      otpRequestId: string;
      messageId: string;
      status: string;
      phoneNumber: string;
    }>(res.body);
    expect(data.otpRequestId).toEqual(expect.any(String));
    expect(data.messageId).toEqual(expect.any(String));
    expect(data.status).toBeDefined();
  });

  it('rejects a send when the wallet balance is below the per-OTP cost (400 INSUFFICIENT_BALANCE)', async () => {
    const user = await registerUser(app, 'otp');
    await onboardUser(app, user.id);

    // Drain the ₹10 welcome credit to 0 so the pre-check fails.
    const wallets = app.get(WalletService);
    const wallet = await wallets.getWallet(user.id);
    await wallets.debit(user.id, Number(wallet.balance), 'zero it for test');

    const res = await request(app.getHttpServer())
      .post('/otp/send')
      .set('Authorization', bearer(user.accessToken))
      .send({ phoneNumber: uniqueMobileIN(), variables: { otp: '123456' } })
      .expect(400);
    expect(errorCode(res.body)).toBe('INSUFFICIENT_BALANCE');
  });

  it('rejects an invalid phone number with 400 VALIDATION_ERROR', async () => {
    const user = await registerUser(app, 'otp');
    await onboardUser(app, user.id);

    const res = await request(app.getHttpServer())
      .post('/otp/send')
      .set('Authorization', bearer(user.accessToken))
      .send({ phoneNumber: '12345', variables: { otp: '123456' } })
      .expect(400);
    expect(errorCode(res.body)).toBe('VALIDATION_ERROR');
  });

  it('requires authentication (401 without a token)', async () => {
    await request(app.getHttpServer())
      .post('/otp/send')
      .send({ phoneNumber: uniqueMobileIN(), variables: { otp: '123456' } })
      .expect(401);
  });
});
