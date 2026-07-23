import { INestApplication } from '@nestjs/common';
import { Repository } from 'typeorm';
import { getRepositoryToken } from '@nestjs/typeorm';
import request from 'supertest';
import { createTestApp } from '../helpers/create-test-app';
import { unwrap, errorCode } from '../helpers/envelope';
import { registerUser, createAdmin, bearer } from '../helpers/auth';
import { User } from '../../src/users/entities/user.entity';
import { KycStatus } from '../../src/users/enums/kyc-status.enum';

describe('PATCH /admin/kyc/:userId', () => {
  let app: INestApplication;
  let userRepo: Repository<User>;

  beforeAll(async () => {
    ({ app } = await createTestApp());
    userRepo = app.get<Repository<User>>(getRepositoryToken(User));
  });

  afterAll(async () => {
    await app.close();
  });

  /** Register a user and force their KYC into the pending state. */
  async function pendingUser(prefix: string) {
    const user = await registerUser(app, prefix);
    await userRepo.update({ id: user.id }, { kycStatus: KycStatus.PENDING });
    return user;
  }

  it('approves a pending KYC submission', async () => {
    const admin = await createAdmin(app);
    const target = await pendingUser('kycok');

    const res = await request(app.getHttpServer())
      .patch(`/admin/kyc/${target.id}`)
      .set('Authorization', bearer(admin.accessToken))
      .send({ action: 'approve' })
      .expect(200);

    const user = unwrap<{
      id: string;
      kycStatus: string;
      hasCompletedOnboarding: boolean;
      kycReviewedBy: string | null;
      password?: string;
    }>(res.body);
    expect(user.kycStatus).toBe(KycStatus.APPROVED);
    expect(user.hasCompletedOnboarding).toBe(true);
    expect(user.kycReviewedBy).toBe(admin.id);
    expect(user.password).toBeUndefined();
  });

  it('rejects a pending KYC submission with a reason', async () => {
    const admin = await createAdmin(app);
    const target = await pendingUser('kycno');

    const res = await request(app.getHttpServer())
      .patch(`/admin/kyc/${target.id}`)
      .set('Authorization', bearer(admin.accessToken))
      .send({ action: 'reject', rejectionReason: 'Document illegible' })
      .expect(200);

    const user = unwrap<{ kycStatus: string; kycRejectionReason: string }>(
      res.body,
    );
    expect(user.kycStatus).toBe(KycStatus.REJECTED);
    expect(user.kycRejectionReason).toBe('Document illegible');
  });

  it('forbids a normal (non-admin) user with 403', async () => {
    const user = await registerUser(app, 'nonadmin');
    const target = await pendingUser('kyctgt');
    await request(app.getHttpServer())
      .patch(`/admin/kyc/${target.id}`)
      .set('Authorization', bearer(user.accessToken))
      .send({ action: 'approve' })
      .expect(403);
  });

  it('rejects an invalid action with 400 VALIDATION_ERROR', async () => {
    const admin = await createAdmin(app);
    const target = await pendingUser('kycbad');
    const res = await request(app.getHttpServer())
      .patch(`/admin/kyc/${target.id}`)
      .set('Authorization', bearer(admin.accessToken))
      .send({ action: 'maybe' })
      .expect(400);
    expect(errorCode(res.body)).toBe('VALIDATION_ERROR');
  });
});
