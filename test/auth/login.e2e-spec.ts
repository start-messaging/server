import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from '../helpers/create-test-app';
import { unwrap, errorCode } from '../helpers/envelope';
import { registerUser, uniqueEmail, DEFAULT_PASSWORD } from '../helpers/auth';

describe('POST /auth/login', () => {
  let app: INestApplication;

  beforeAll(async () => {
    ({ app } = await createTestApp());
  });

  afterAll(async () => {
    await app.close();
  });

  it('logs in with the registered email + password and returns a token + user', async () => {
    const user = await registerUser(app, 'login');

    const res = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: user.email, password: user.password })
      .expect(201);

    const data = unwrap<{
      accessToken: string;
      user: { id: string; email: string; role: string };
    }>(res.body);
    expect(data.accessToken).toEqual(expect.any(String));
    expect(data.user.id).toBe(user.id);
    expect(data.user.email).toBe(user.email);
  });

  it('rejects a wrong password with 401', async () => {
    const user = await registerUser(app, 'login-wrongpw');

    await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: user.email, password: 'Wr0ngPassword!456' })
      .expect(401);
  });

  it('rejects an unknown email with 401', async () => {
    await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: uniqueEmail('nobody'), password: DEFAULT_PASSWORD })
      .expect(401);
  });

  it('rejects invalid input with 400 VALIDATION_ERROR', async () => {
    const res = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: 'not-an-email' })
      .expect(400);
    expect(errorCode(res.body)).toBe('VALIDATION_ERROR');
  });
});
