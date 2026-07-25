import { INestApplication } from '@nestjs/common';
import { randomUUID } from 'crypto';
import request from 'supertest';
import { createTestApp } from '../helpers/create-test-app';
import { unwrap, errorCode } from '../helpers/envelope';
import { registerUser, createAdmin, bearer } from '../helpers/auth';

describe('PATCH /admin/users/:id', () => {
  let app: INestApplication;

  beforeAll(async () => {
    ({ app } = await createTestApp());
  });

  afterAll(async () => {
    await app.close();
  });

  it('updates admin-managed fields on a user', async () => {
    const admin = await createAdmin(app);
    const target = await registerUser(app, 'target');

    const res = await request(app.getHttpServer())
      .patch(`/admin/users/${target.id}`)
      .set('Authorization', bearer(admin.accessToken))
      .send({ isActive: false, adminCallNotes: 'Called re: KYC' })
      .expect(200);

    const user = unwrap<{
      id: string;
      isActive: boolean;
      adminCallNotes: string | null;
      password?: string;
    }>(res.body);
    expect(user.id).toBe(target.id);
    expect(user.isActive).toBe(false);
    expect(user.adminCallNotes).toBe('Called re: KYC');
    // Password must never leak on an admin response.
    expect(user.password).toBeUndefined();
  });

  it('forbids a normal (non-admin) user with 403', async () => {
    const user = await registerUser(app, 'nonadmin');
    const target = await registerUser(app, 'target');
    await request(app.getHttpServer())
      .patch(`/admin/users/${target.id}`)
      .set('Authorization', bearer(user.accessToken))
      .send({ isActive: false })
      .expect(403);
  });

  it('rejects an invalid body with 400 VALIDATION_ERROR', async () => {
    const admin = await createAdmin(app);
    const res = await request(app.getHttpServer())
      .patch(`/admin/users/${randomUUID()}`)
      .set('Authorization', bearer(admin.accessToken))
      .send({ adminLastCalledAt: 'not-a-real-date' })
      .expect(400);
    expect(errorCode(res.body)).toBe('VALIDATION_ERROR');
  });
});
