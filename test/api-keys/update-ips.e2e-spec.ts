import { INestApplication } from '@nestjs/common';
import { randomUUID } from 'crypto';
import request from 'supertest';
import { createTestApp } from '../helpers/create-test-app';
import { unwrap, errorCode } from '../helpers/envelope';
import { registerUser, onboardUser, bearer } from '../helpers/auth';

interface CreatedKey {
  id: string;
  keyPrefix: string;
  allowedIps: string[] | null;
}

async function createKey(
  app: INestApplication,
  token: string,
): Promise<CreatedKey> {
  const res = await request(app.getHttpServer())
    .post('/api-keys')
    .set('Authorization', bearer(token))
    .send({ label: 'to-restrict' })
    .expect(201);
  return unwrap<CreatedKey>(res.body);
}

describe('PATCH /api-keys/:id/ip-restrictions — update allowed IPs', () => {
  let app: INestApplication;

  beforeAll(async () => {
    ({ app } = await createTestApp());
  });

  afterAll(async () => {
    await app.close();
  });

  it('sets the allowed IPs on an existing key', async () => {
    const user = await registerUser(app, 'apikey');
    await onboardUser(app, user.id);
    const created = await createKey(app, user.accessToken);

    const res = await request(app.getHttpServer())
      .patch(`/api-keys/${created.id}/ip-restrictions`)
      .set('Authorization', bearer(user.accessToken))
      .send({ allowedIps: ['203.0.113.5', '198.51.100.10'] })
      .expect(200);

    const updated = unwrap<CreatedKey>(res.body);
    expect(updated.id).toBe(created.id);
    expect(updated.allowedIps).toEqual(['203.0.113.5', '198.51.100.10']);
  });

  it('clears restrictions when given an empty array (normalises to null)', async () => {
    const user = await registerUser(app, 'apikey');
    await onboardUser(app, user.id);
    const created = await createKey(app, user.accessToken);

    const res = await request(app.getHttpServer())
      .patch(`/api-keys/${created.id}/ip-restrictions`)
      .set('Authorization', bearer(user.accessToken))
      .send({ allowedIps: [] })
      .expect(200);

    expect(unwrap<CreatedKey>(res.body).allowedIps).toBeNull();
  });

  it('rejects an invalid IP (400 VALIDATION_ERROR)', async () => {
    const user = await registerUser(app, 'apikey');
    await onboardUser(app, user.id);
    const created = await createKey(app, user.accessToken);

    const res = await request(app.getHttpServer())
      .patch(`/api-keys/${created.id}/ip-restrictions`)
      .set('Authorization', bearer(user.accessToken))
      .send({ allowedIps: ['999.999.999.999'] })
      .expect(400);

    expect(errorCode(res.body)).toBe('VALIDATION_ERROR');
  });

  it('returns 404 for an API key the caller does not own / that does not exist', async () => {
    const user = await registerUser(app, 'apikey');
    await onboardUser(app, user.id);

    await request(app.getHttpServer())
      .patch(`/api-keys/${randomUUID()}/ip-restrictions`)
      .set('Authorization', bearer(user.accessToken))
      .send({ allowedIps: ['203.0.113.5'] })
      .expect(404);
  });

  it('requires authentication (401 without a token)', async () => {
    await request(app.getHttpServer())
      .patch(`/api-keys/${randomUUID()}/ip-restrictions`)
      .send({ allowedIps: ['203.0.113.5'] })
      .expect(401);
  });
});
