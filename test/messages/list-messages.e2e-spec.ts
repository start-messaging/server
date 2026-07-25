import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from '../helpers/create-test-app';
import { unwrap, pagination, errorCode } from '../helpers/envelope';
import { registerUser, onboardUser, bearer } from '../helpers/auth';

describe('Messages & dashboard read endpoints', () => {
  let app: INestApplication;

  beforeAll(async () => {
    ({ app } = await createTestApp());
  });

  afterAll(async () => {
    await app.close();
  });

  describe('GET /messages', () => {
    it('returns a paginated (possibly empty) list for an onboarded user', async () => {
      const user = await registerUser(app, 'msg');
      await onboardUser(app, user.id);

      const res = await request(app.getHttpServer())
        .get('/messages')
        .set('Authorization', bearer(user.accessToken))
        .expect(200);

      const items = unwrap<Array<unknown>>(res.body);
      expect(Array.isArray(items)).toBe(true);

      const meta = pagination(res.body);
      expect(meta.page).toBe(1);
      expect(typeof meta.totalItems).toBe('number');
      expect(typeof meta.totalPages).toBe('number');
    });

    it('rejects an invalid pagination param with 400 VALIDATION_ERROR', async () => {
      const user = await registerUser(app, 'msg');
      await onboardUser(app, user.id);

      const res = await request(app.getHttpServer())
        .get('/messages?page=0')
        .set('Authorization', bearer(user.accessToken))
        .expect(400);
      expect(errorCode(res.body)).toBe('VALIDATION_ERROR');
    });

    it('requires authentication (401 without a token)', async () => {
      await request(app.getHttpServer()).get('/messages').expect(401);
    });
  });

  describe('GET /dashboard/stats', () => {
    it('returns dashboard stats for an onboarded user', async () => {
      const user = await registerUser(app, 'dash');
      await onboardUser(app, user.id);

      const res = await request(app.getHttpServer())
        .get('/dashboard/stats')
        .set('Authorization', bearer(user.accessToken))
        .expect(200);

      const stats = unwrap<{
        filtered: { requested: number; delivered: number; failed: number };
        total: { messages: number; cost: number };
      }>(res.body);
      expect(stats.filtered).toBeDefined();
      expect(typeof stats.filtered.requested).toBe('number');
      expect(typeof stats.total.messages).toBe('number');
    });

    it('requires authentication (401 without a token)', async () => {
      await request(app.getHttpServer()).get('/dashboard/stats').expect(401);
    });
  });
});
