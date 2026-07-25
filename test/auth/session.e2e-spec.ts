import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from '../helpers/create-test-app';
import { unwrap } from '../helpers/envelope';
import {
  registerUser,
  uniqueEmail,
  DEFAULT_PASSWORD,
  bearer,
} from '../helpers/auth';

/**
 * Session lifecycle: the current-user profile route, refresh-token rotation via
 * the httpOnly `refresh_token` cookie, and logout (which revokes that token).
 * The refresh cookie is set on register/login as "<userId>:<token>" — we capture
 * it from the register response's `set-cookie` header and replay it via `Cookie`.
 */
describe('Auth session', () => {
  let app: INestApplication;

  beforeAll(async () => {
    ({ app } = await createTestApp());
  });

  afterAll(async () => {
    await app.close();
  });

  interface RawRegistration {
    email: string;
    userId: string;
    accessToken: string;
    refreshCookie: string;
  }

  /** Register a fresh user, returning the token AND the raw refresh_token cookie. */
  async function registerRaw(prefix: string): Promise<RawRegistration> {
    const email = uniqueEmail(prefix);
    const res = await request(app.getHttpServer())
      .post('/auth/register')
      .send({
        email,
        password: DEFAULT_PASSWORD,
        firstName: 'A',
        lastName: 'B',
      })
      .expect(201);

    const data = unwrap<{ accessToken: string; user: { id: string } }>(
      res.body,
    );
    const setCookies = res.headers['set-cookie'] as unknown as string[];
    const refreshCookie = setCookies
      .find((c) => c.startsWith('refresh_token='))!
      .split(';')[0];

    return {
      email,
      userId: data.user.id,
      accessToken: data.accessToken,
      refreshCookie,
    };
  }

  describe('GET /users/me', () => {
    it('returns the current user profile without the password', async () => {
      const user = await registerUser(app, 'me');
      const res = await request(app.getHttpServer())
        .get('/users/me')
        .set('Authorization', bearer(user.accessToken))
        .expect(200);

      const profile = unwrap<{
        id: string;
        email: string;
        passwordHash?: string;
      }>(res.body);
      expect(profile.id).toBe(user.id);
      expect(profile.email).toBe(user.email);
      expect(profile.passwordHash).toBeUndefined();
    });

    it('rejects an unauthenticated request with 401', async () => {
      await request(app.getHttpServer()).get('/users/me').expect(401);
    });
  });

  describe('POST /auth/refresh', () => {
    it('rotates the tokens when given a valid refresh cookie', async () => {
      const reg = await registerRaw('refresh');

      const res = await request(app.getHttpServer())
        .post('/auth/refresh')
        .set('Cookie', reg.refreshCookie)
        .expect(201);

      const data = unwrap<{ accessToken: string; user: { id: string } }>(
        res.body,
      );
      expect(data.accessToken).toEqual(expect.any(String));
      expect(data.user.id).toBe(reg.userId);

      // A fresh refresh_token cookie is re-issued on every rotation.
      const setCookies = res.headers['set-cookie'] as unknown as string[];
      expect(setCookies.some((c) => c.startsWith('refresh_token='))).toBe(true);
    });

    it('rejects a request with no refresh cookie with 401', async () => {
      await request(app.getHttpServer()).post('/auth/refresh').expect(401);
    });

    it('rejects a malformed refresh cookie with 401', async () => {
      await request(app.getHttpServer())
        .post('/auth/refresh')
        .set('Cookie', 'refresh_token=not-a-valid-value')
        .expect(401);
    });
  });

  describe('POST /auth/logout', () => {
    it('logs out and revokes the refresh token', async () => {
      const reg = await registerRaw('logout');

      const res = await request(app.getHttpServer())
        .post('/auth/logout')
        .set('Authorization', bearer(reg.accessToken))
        .expect(201);
      expect(unwrap<{ message: string }>(res.body).message).toBe('Logged out');

      // The stored refresh token is revoked, so replaying the cookie now fails.
      await request(app.getHttpServer())
        .post('/auth/refresh')
        .set('Cookie', reg.refreshCookie)
        .expect(401);
    });

    it('rejects an unauthenticated logout with 401', async () => {
      await request(app.getHttpServer()).post('/auth/logout').expect(401);
    });
  });
});
