import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from '../helpers/create-test-app';
import { unwrap } from '../helpers/envelope';
import { registerUser, onboardUser, bearer } from '../helpers/auth';

interface CreatedKey {
  id: string;
  key: string;
  keyPrefix: string;
}

interface ListedKey {
  id: string;
  keyPrefix: string;
  label: string;
}

async function createKey(
  app: INestApplication,
  token: string,
  label = 'listed',
): Promise<CreatedKey> {
  const res = await request(app.getHttpServer())
    .post('/api-keys')
    .set('Authorization', bearer(token))
    .send({ label })
    .expect(201);
  return unwrap<CreatedKey>(res.body);
}

describe('GET /api-keys — list the caller’s API keys', () => {
  let app: INestApplication;

  beforeAll(async () => {
    ({ app } = await createTestApp());
  });

  afterAll(async () => {
    await app.close();
  });

  it('includes the created key but never leaks the raw secret', async () => {
    const user = await registerUser(app, 'apikey');
    await onboardUser(app, user.id);
    const created = await createKey(app, user.accessToken, 'My key');

    const res = await request(app.getHttpServer())
      .get('/api-keys')
      .set('Authorization', bearer(user.accessToken))
      .expect(200);

    const list = unwrap<ListedKey[]>(res.body);
    const found = list.find((k) => k.id === created.id);
    expect(found).toBeDefined();
    expect(found?.keyPrefix).toBe(created.keyPrefix);
    // The one-time raw key is not returned by the list endpoint.
    expect(found).not.toHaveProperty('key');
  });

  it('scopes the list to the owner (never another user’s keys)', async () => {
    const owner = await registerUser(app, 'apikey');
    await onboardUser(app, owner.id);
    const created = await createKey(app, owner.accessToken, 'owner key');

    const other = await registerUser(app, 'apikey');
    await onboardUser(app, other.id);

    const res = await request(app.getHttpServer())
      .get('/api-keys')
      .set('Authorization', bearer(other.accessToken))
      .expect(200);

    const list = unwrap<ListedKey[]>(res.body);
    expect(list.some((k) => k.id === created.id)).toBe(false);
  });

  it('requires authentication (401 without a token)', async () => {
    await request(app.getHttpServer()).get('/api-keys').expect(401);
  });
});
