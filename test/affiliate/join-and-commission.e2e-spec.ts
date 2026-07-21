import { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { getRepositoryToken } from '@nestjs/typeorm';
import { randomUUID } from 'crypto';
import request from 'supertest';
import { createTestApp } from '../helpers/create-test-app';
import { unwrap, errorCode } from '../helpers/envelope';
import {
  registerUser,
  uniqueEmail,
  DEFAULT_PASSWORD,
  bearer,
} from '../helpers/auth';
import { ReferralService } from '../../src/referral/referral.service';
import {
  Referral,
  ReferralStatus,
} from '../../src/referral/entities/referral.entity';
import { ReferralProfile } from '../../src/referral/entities/referral-profile.entity';

describe('Affiliate — join, attribution and commission', () => {
  let app: INestApplication;

  beforeAll(async () => {
    ({ app } = await createTestApp());
  });

  afterAll(async () => {
    await app.close();
  });

  it('joins the program and returns a referral code', async () => {
    const partner = await registerUser(app, 'partner');
    const res = await request(app.getHttpServer())
      .post('/partner/join')
      .set('Authorization', bearer(partner.accessToken))
      .send({})
      .expect(201);
    const profile = unwrap<{ referralCode: string; commissionPercent: number }>(
      res.body,
    );
    expect(profile.referralCode).toMatch(/^[A-Z0-9]{8}$/);
    expect(profile.commissionPercent).toBe(10);
  });

  it('rejects a second join with ALREADY_A_PARTNER', async () => {
    const partner = await registerUser(app, 'partner');
    await request(app.getHttpServer())
      .post('/partner/join')
      .set('Authorization', bearer(partner.accessToken))
      .send({})
      .expect(201);
    const res = await request(app.getHttpServer())
      .post('/partner/join')
      .set('Authorization', bearer(partner.accessToken))
      .send({})
      .expect(400);
    expect(errorCode(res.body)).toBe('ALREADY_A_PARTNER');
  });

  it('attributes a signup with a referral code and pays commission on payment', async () => {
    // Partner joins to get a code.
    const partner = await registerUser(app, 'partner');
    const joinRes = await request(app.getHttpServer())
      .post('/partner/join')
      .set('Authorization', bearer(partner.accessToken))
      .send({})
      .expect(201);
    const code = unwrap<{ referralCode: string }>(joinRes.body).referralCode;

    // A new user signs up WITH the referral code.
    const referredEmail = uniqueEmail('referred');
    const signup = await request(app.getHttpServer())
      .post('/auth/register')
      .send({
        email: referredEmail,
        password: DEFAULT_PASSWORD,
        firstName: 'R',
        lastName: 'U',
        referralCode: code,
      })
      .expect(201);
    const referredUserId = unwrap<{ user: { id: string } }>(signup.body).user
      .id;

    // Attribution row exists, still just signed_up.
    const referralRepo = app.get<import('typeorm').Repository<Referral>>(
      getRepositoryToken(Referral),
    );
    const attribution = await referralRepo.findOne({
      where: { referredUserId },
    });
    expect(attribution?.partnerUserId).toBe(partner.id);
    expect(attribution?.status).toBe(ReferralStatus.SIGNED_UP);

    // Simulate a completed ₹1000 top-up (base = 1_000_000_000 micros) via the
    // same hook payments use, inside a transaction.
    const ds = app.get(DataSource);
    const referral = app.get(ReferralService);
    const baseMicros = 1_000_000_000;
    const paymentId = randomUUID();
    await ds.transaction((m) =>
      referral.recordCommissionForPayment(
        m,
        referredUserId,
        paymentId,
        baseMicros,
      ),
    );

    // 10% commission = 100_000_000 micros credited; referral now paid.
    const profileRepo = app.get<import('typeorm').Repository<ReferralProfile>>(
      getRepositoryToken(ReferralProfile),
    );
    const profile = await profileRepo.findOne({
      where: { userId: partner.id },
    });
    expect(Number(profile?.earningsBalance)).toBe(100_000_000);
    expect(Number(profile?.totalEarned)).toBe(100_000_000);
    expect(profile?.paidUsersCount).toBe(1);

    const updated = await referralRepo.findOne({ where: { referredUserId } });
    expect(updated?.status).toBe(ReferralStatus.PAID);

    // Idempotent: re-running the same paymentId must not double-pay.
    await ds.transaction((m) =>
      referral.recordCommissionForPayment(
        m,
        referredUserId,
        paymentId,
        baseMicros,
      ),
    );
    const after = await profileRepo.findOne({ where: { userId: partner.id } });
    expect(Number(after?.earningsBalance)).toBe(100_000_000);
    expect(after?.paidUsersCount).toBe(1);
  });

  it('ignores an invalid referral code at signup (no attribution)', async () => {
    const signup = await request(app.getHttpServer())
      .post('/auth/register')
      .send({
        email: uniqueEmail('noref'),
        password: DEFAULT_PASSWORD,
        firstName: 'N',
        lastName: 'R',
        referralCode: 'ZZZZZZZZ',
      })
      .expect(201);
    const userId = unwrap<{ user: { id: string } }>(signup.body).user.id;
    const referralRepo = app.get<import('typeorm').Repository<Referral>>(
      getRepositoryToken(Referral),
    );
    expect(
      await referralRepo.findOne({ where: { referredUserId: userId } }),
    ).toBeNull();
  });
});
