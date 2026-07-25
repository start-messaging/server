import { INestApplication } from '@nestjs/common';
import { Repository } from 'typeorm';
import { getRepositoryToken } from '@nestjs/typeorm';
import request from 'supertest';
import { createTestApp } from '../helpers/create-test-app';
import { unwrap, pagination } from '../helpers/envelope';
import { registerUser, createAdmin, bearer } from '../helpers/auth';
import { User } from '../../src/users/entities/user.entity';
import { KycStatus } from '../../src/users/enums/kyc-status.enum';

describe('GET /admin/kyc', () => {
  let app: INestApplication;
  let userRepo: Repository<User>;

  beforeAll(async () => {
    ({ app } = await createTestApp());
    userRepo = app.get<Repository<User>>(getRepositoryToken(User));
  });

  afterAll(async () => {
    await app.close();
  });

  it('lists KYC submissions (paginated) for an admin', async () => {
    const admin = await createAdmin(app);
    // Seed a pending submission so the list is non-empty and filterable.
    const submitter = await registerUser(app, 'kycsub');
    await userRepo.update(
      { id: submitter.id },
      { kycStatus: KycStatus.PENDING },
    );

    const res = await request(app.getHttpServer())
      .get('/admin/kyc')
      .query({ page: 1, limit: 10, status: KycStatus.PENDING })
      .set('Authorization', bearer(admin.accessToken))
      .expect(200);

    const items = unwrap<Array<{ id: string; kycStatus: KycStatus }>>(res.body);
    expect(Array.isArray(items)).toBe(true);
    expect(items.every((u) => u.kycStatus === KycStatus.PENDING)).toBe(true);

    const page = pagination(res.body);
    expect(page.page).toBe(1);
    expect(typeof page.totalItems).toBe('number');
    expect(typeof page.totalPages).toBe('number');
  });

  it('forbids a normal (non-admin) user with 403', async () => {
    const user = await registerUser(app, 'nonadmin');
    await request(app.getHttpServer())
      .get('/admin/kyc')
      .set('Authorization', bearer(user.accessToken))
      .expect(403);
  });

  it('requires authentication (401 without a token)', async () => {
    await request(app.getHttpServer()).get('/admin/kyc').expect(401);
  });
});
