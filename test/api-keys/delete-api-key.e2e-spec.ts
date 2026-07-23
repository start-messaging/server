import { INestApplication } from '@nestjs/common';
import { randomUUID } from 'crypto';
import request from 'supertest';
import { createTestApp } from '../helpers/create-test-app';
import { unwrap } from '../helpers/envelope';
import { registerUser, onboardUser, bearer } from '../helpers/auth';

interface CreatedKey {
  id: string;
  keyPrefix: string;
}

interface ListedKey {
  id: string;
}

async function createKey(
  app: INestApplication,
  token: string,
): Promise<CreatedKey> {
  const res = await request(app.getHttpServer())
    .post('/api-keys')
    .set('Authorization', bearer(token))
    .send({ label: 'to-delete' })
    .expect(201);
  return unwrap<CreatedKey>(res.body);
}

describe('DELETE /api-keys/:id — revoke an API key', () => {
  let app: INestApplication;

  beforeAll(async () => {
    ({ app } = await createTestApp());
  });

  afterAll(async () => {
    await app.close();
  });

  it('deletes the key so it no longer appears in the list', async () => {
    const user = await registerUser(app, 'apikey');
    await onboardUser(app, user.id);
    const created = await createKey(app, user.accessToken);

    await request(app.getHttpServer())
      .delete(`/api-keys/${created.id}`)
      .set('Authorization', bearer(user.accessToken))
      .expect(200);

    const listRes = await request(app.getHttpServer())
      .get('/api-keys')
      .set('Authorization', bearer(user.accessToken))
      .expect(200);

    const list = unwrap<ListedKey[]>(listRes.body);
    expect(list.some((k) => k.id === created.id)).toBe(false);
  });

  it('returns 404 for an API key the caller does not own / that does not exist', async () => {
    const user = await registerUser(app, 'apikey');
    await onboardUser(app, user.id);

    await request(app.getHttpServer())
      .delete(`/api-keys/${randomUUID()}`)
      .set('Authorization', bearer(user.accessToken))
      .expect(404);
  });

  it('requires authentication (401 without a token)', async () => {
    await request(app.getHttpServer())
      .delete(`/api-keys/${randomUUID()}`)
      .expect(401);
  });
});
