import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from '../helpers/create-test-app';
import { unwrap, errorCode } from '../helpers/envelope';
import { registerPartner, bearer } from '../helpers/auth';

describe('Partner session — /me, refresh, logout', () => {
  let app: INestApplication;

  beforeAll(async () => {
    ({ app } = await createTestApp());
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /partner/auth/me returns the authenticated partner', async () => {
    const partner = await registerPartner(app, 'me');
    const res = await request(app.getHttpServer())
      .get('/partner/auth/me')
      .set('Authorization', bearer(partner.accessToken))
      .expect(200);
    const me = unwrap<{ id: string; email: string }>(res.body);
    expect(me.id).toBe(partner.id);
    expect(me.email).toBe(partner.email);
  });

  it('GET /partner/auth/me without a token is 401', async () => {
    await request(app.getHttpServer()).get('/partner/auth/me').expect(401);
  });

  it('refresh rotates the token and invalidates the old refresh token', async () => {
    const partner = await registerPartner(app, 'refresh');

    const first = await request(app.getHttpServer())
      .post('/partner/auth/refresh')
      .send({ refreshToken: partner.refreshToken })
      .expect(200);
    const rotated = unwrap<{ accessToken: string; refreshToken: string }>(
      first.body,
    );
    expect(rotated.refreshToken).not.toBe(partner.refreshToken);

    // The new access token works.
    await request(app.getHttpServer())
      .get('/partner/me')
      .set('Authorization', bearer(rotated.accessToken))
      .expect(200);

    // Re-using the ORIGINAL (rotated-out) refresh token is rejected.
    await request(app.getHttpServer())
      .post('/partner/auth/refresh')
      .send({ refreshToken: partner.refreshToken })
      .expect(401);
  });

  it('rejects a malformed refresh token with 401', async () => {
    const res = await request(app.getHttpServer())
      .post('/partner/auth/refresh')
      .send({ refreshToken: 'garbage-no-dot' })
      .expect(401);
    expect(errorCode(res.body)).toBe('INVALID_CREDENTIALS');
  });

  it('logout revokes the refresh token', async () => {
    const partner = await registerPartner(app, 'logout');

    await request(app.getHttpServer())
      .post('/partner/auth/logout')
      .set('Authorization', bearer(partner.accessToken))
      .expect(204);

    // Refreshing after logout fails (the stored hash was cleared).
    await request(app.getHttpServer())
      .post('/partner/auth/refresh')
      .send({ refreshToken: partner.refreshToken })
      .expect(401);
  });
});
