import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from '../helpers/create-test-app';
import { unwrap, errorCode } from '../helpers/envelope';
import { registerUser, bearer } from '../helpers/auth';

// PATCH /users/me — @SkipOnboarding() at the controller level, so only a JWT is
// required. Default status for PATCH is 200 (no @HttpCode override).
describe('PATCH /users/me', () => {
  let app: INestApplication;

  beforeAll(async () => {
    ({ app } = await createTestApp());
  });

  afterAll(async () => {
    await app.close();
  });

  it('updates editable profile fields and returns the fresh profile', async () => {
    const user = await registerUser(app, 'upd');
    const res = await request(app.getHttpServer())
      .patch('/users/me')
      .set('Authorization', bearer(user.accessToken))
      .send({ firstName: 'Renamed', companyName: 'Acme Pvt Ltd' })
      .expect(200);

    const data = unwrap<{
      id: string;
      firstName: string;
      companyName: string;
      passwordHash?: string;
    }>(res.body);
    expect(data.id).toBe(user.id);
    expect(data.firstName).toBe('Renamed');
    expect(data.companyName).toBe('Acme Pvt Ltd');
    expect(data.passwordHash).toBeUndefined();
  });

  it('rejects an unauthenticated request with 401', async () => {
    await request(app.getHttpServer())
      .patch('/users/me')
      .send({ firstName: 'Nope' })
      .expect(401);
  });

  it('rejects an invalid websiteUrl with 400 VALIDATION_ERROR', async () => {
    const user = await registerUser(app, 'upd');
    const res = await request(app.getHttpServer())
      .patch('/users/me')
      .set('Authorization', bearer(user.accessToken))
      .send({ websiteUrl: 'not a valid url' })
      .expect(400);
    expect(errorCode(res.body)).toBe('VALIDATION_ERROR');
  });
});
