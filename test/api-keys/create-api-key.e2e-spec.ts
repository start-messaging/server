import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from '../helpers/create-test-app';
import { unwrap, errorCode } from '../helpers/envelope';
import { registerUser, onboardUser, bearer } from '../helpers/auth';

interface CreatedKey {
  id: string;
  key: string;
  keyPrefix: string;
  label: string;
  allowedIps: string[] | null;
}

describe('POST /api-keys — create an API key', () => {
  let app: INestApplication;

  beforeAll(async () => {
    ({ app } = await createTestApp());
  });

  afterAll(async () => {
    await app.close();
  });

  it('returns the raw key once, with a matching 12-char keyPrefix', async () => {
    const user = await registerUser(app, 'apikey');
    await onboardUser(app, user.id);

    const res = await request(app.getHttpServer())
      .post('/api-keys')
      .set('Authorization', bearer(user.accessToken))
      .send({ label: 'Production Key', allowedIps: ['203.0.113.5'] })
      .expect(201);

    const created = unwrap<CreatedKey>(res.body);
    expect(created.id).toEqual(expect.any(String));
    expect(created.key).toMatch(/^sm_live_/);
    expect(created.keyPrefix).toHaveLength(12);
    expect(created.keyPrefix).toBe(created.key.slice(0, 12));
    expect(created.label).toBe('Production Key');
    expect(created.allowedIps).toEqual(['203.0.113.5']);
  });

  it('allows omitting optional fields (no label, no IP restrictions)', async () => {
    const user = await registerUser(app, 'apikey');
    await onboardUser(app, user.id);

    const res = await request(app.getHttpServer())
      .post('/api-keys')
      .set('Authorization', bearer(user.accessToken))
      .send({})
      .expect(201);

    const created = unwrap<CreatedKey>(res.body);
    expect(created.key).toMatch(/^sm_live_/);
    // Empty/omitted allowedIps normalises to null (allow all).
    expect(created.allowedIps).toBeNull();
  });

  it('rejects an invalid IP in allowedIps (400 VALIDATION_ERROR)', async () => {
    const user = await registerUser(app, 'apikey');
    await onboardUser(app, user.id);

    const res = await request(app.getHttpServer())
      .post('/api-keys')
      .set('Authorization', bearer(user.accessToken))
      .send({ allowedIps: ['not-an-ip'] })
      .expect(400);

    expect(errorCode(res.body)).toBe('VALIDATION_ERROR');
  });

  it('requires authentication (401 without a token)', async () => {
    await request(app.getHttpServer())
      .post('/api-keys')
      .send({ label: 'nope' })
      .expect(401);
  });
});
