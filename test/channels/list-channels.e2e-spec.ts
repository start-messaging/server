import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from '../helpers/create-test-app';
import { unwrap } from '../helpers/envelope';
import { registerUser, bearer } from '../helpers/auth';

describe('Channels & system templates (read)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    ({ app } = await createTestApp());
  });

  afterAll(async () => {
    await app.close();
  });

  describe('GET /channels', () => {
    // @SkipOnboarding — a plain registered (non-onboarded) user is allowed.
    it('lists the seeded active SMS channel', async () => {
      const user = await registerUser(app, 'chan');

      const res = await request(app.getHttpServer())
        .get('/channels')
        .set('Authorization', bearer(user.accessToken))
        .expect(200);

      const channels = unwrap<
        Array<{ id: string; name: string; isActive: boolean }>
      >(res.body);
      expect(Array.isArray(channels)).toBe(true);
      const sms = channels.find((c) => c.name === 'sms');
      expect(sms).toBeDefined();
      expect(sms?.isActive).toBe(true);
    });

    it('requires authentication (401 without a token)', async () => {
      await request(app.getHttpServer()).get('/channels').expect(401);
    });
  });

  describe('GET /channels/:id/templates', () => {
    it('returns approved system templates including the seeded "Standard OTP"', async () => {
      const user = await registerUser(app, 'chan');

      const list = await request(app.getHttpServer())
        .get('/channels')
        .set('Authorization', bearer(user.accessToken))
        .expect(200);
      const sms = unwrap<Array<{ id: string; name: string }>>(list.body).find(
        (c) => c.name === 'sms',
      );
      expect(sms).toBeDefined();

      const res = await request(app.getHttpServer())
        .get(`/channels/${sms!.id}/templates`)
        .set('Authorization', bearer(user.accessToken))
        .expect(200);

      const templates = unwrap<
        Array<{ id: string; name: string; status: string }>
      >(res.body);
      expect(Array.isArray(templates)).toBe(true);
      expect(templates.some((t) => t.name === 'Standard OTP')).toBe(true);
    });

    it('requires authentication (401 without a token)', async () => {
      await request(app.getHttpServer())
        .get('/channels/00000000-0000-0000-0000-000000000000/templates')
        .expect(401);
    });
  });
});
