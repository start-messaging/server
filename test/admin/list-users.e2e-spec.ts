import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from '../helpers/create-test-app';
import { unwrap, pagination } from '../helpers/envelope';
import { registerUser, createAdmin, bearer } from '../helpers/auth';

describe('GET /admin/users', () => {
  let app: INestApplication;

  beforeAll(async () => {
    ({ app } = await createTestApp());
  });

  afterAll(async () => {
    await app.close();
  });

  it('returns a paginated user list for an admin', async () => {
    const admin = await createAdmin(app);
    // Ensure there is at least one more user in the table.
    await registerUser(app, 'listed');

    const res = await request(app.getHttpServer())
      .get('/admin/users')
      .query({ page: 1, limit: 5 })
      .set('Authorization', bearer(admin.accessToken))
      .expect(200);

    const items = unwrap<Array<{ id: string; email: string }>>(res.body);
    expect(Array.isArray(items)).toBe(true);
    expect(items.length).toBeLessThanOrEqual(5);

    const page = pagination(res.body);
    expect(page.page).toBe(1);
    expect(typeof page.totalItems).toBe('number');
    expect(typeof page.totalPages).toBe('number');
    expect(page.totalItems).toBeGreaterThanOrEqual(1);
  });

  it('forbids a normal (non-admin) user with 403', async () => {
    const user = await registerUser(app, 'nonadmin');
    await request(app.getHttpServer())
      .get('/admin/users')
      .set('Authorization', bearer(user.accessToken))
      .expect(403);
  });

  it('requires authentication (401 without a token)', async () => {
    await request(app.getHttpServer()).get('/admin/users').expect(401);
  });
});
