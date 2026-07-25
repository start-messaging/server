import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from '../helpers/create-test-app';
import { unwrap } from '../helpers/envelope';
import { registerUser, bearer } from '../helpers/auth';

// The whole UsersController is @SkipOnboarding(), so a freshly registered
// (not-yet-onboarded) user can read their own profile with just a JWT.
describe('GET /users/me', () => {
  let app: INestApplication;

  beforeAll(async () => {
    ({ app } = await createTestApp());
  });

  afterAll(async () => {
    await app.close();
  });

  it('returns the current user profile without the password hash', async () => {
    const user = await registerUser(app, 'me');
    const res = await request(app.getHttpServer())
      .get('/users/me')
      .set('Authorization', bearer(user.accessToken))
      .expect(200);

    const data = unwrap<{
      id: string;
      email: string;
      role: string;
      passwordHash?: string;
    }>(res.body);
    expect(data.id).toBe(user.id);
    expect(data.email).toBe(user.email);
    expect(data.role).toBe('customer');
    // excludePassword() strips the credential before serialization.
    expect(data.passwordHash).toBeUndefined();
  });

  it('rejects an unauthenticated request with 401', async () => {
    await request(app.getHttpServer()).get('/users/me').expect(401);
  });

  it('rejects a malformed bearer token with 401', async () => {
    await request(app.getHttpServer())
      .get('/users/me')
      .set('Authorization', bearer('not-a-real-token'))
      .expect(401);
  });
});
