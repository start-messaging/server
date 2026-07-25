import { INestApplication } from '@nestjs/common';
import { DataSource, Repository } from 'typeorm';
import { getRepositoryToken } from '@nestjs/typeorm';
import { randomUUID } from 'crypto';
import request from 'supertest';
import { createTestApp } from '../helpers/create-test-app';
import { unwrap } from '../helpers/envelope';
import {
  registerPartner,
  uniqueEmail,
  DEFAULT_PASSWORD,
  bearer,
} from '../helpers/auth';
import { ReferralService } from '../../src/referral/referral.service';
import {
  Referral,
  ReferralStatus,
} from '../../src/referral/entities/referral.entity';
import { ReferralPartner } from '../../src/referral/entities/referral-partner.entity';

describe('Affiliate — attribution and commission', () => {
  let app: INestApplication;
  let partners: Repository<ReferralPartner>;
  let referrals: Repository<Referral>;

  beforeAll(async () => {
    ({ app } = await createTestApp());
    partners = app.get<Repository<ReferralPartner>>(
      getRepositoryToken(ReferralPartner),
    );
    referrals = app.get<Repository<Referral>>(getRepositoryToken(Referral));
  });

  afterAll(async () => {
    await app.close();
  });

  it('gives a registered partner a referral code and 10% rate', async () => {
    const partner = await registerPartner(app, 'partner');
    expect(partner.referralCode).toMatch(/^[A-Z0-9]{8}$/);

    const res = await request(app.getHttpServer())
      .get('/partner/stats')
      .set('Authorization', bearer(partner.accessToken))
      .expect(200);
    const stats = unwrap<{ profile: { commissionPercent: number } }>(res.body);
    expect(stats.profile.commissionPercent).toBe(10);
  });

  it('attributes a signup with a referral code and pays commission on payment', async () => {
    const partner = await registerPartner(app, 'partner');
    const code = partner.referralCode;

    // A new customer signs up WITH the referral code.
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

    // Attribution row exists, still just signed_up, keyed to the PARTNER id.
    const attribution = await referrals.findOne({ where: { referredUserId } });
    expect(attribution?.partnerId).toBe(partner.id);
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
    const p = await partners.findOne({ where: { id: partner.id } });
    expect(Number(p?.earningsBalance)).toBe(100_000_000);
    expect(Number(p?.totalEarned)).toBe(100_000_000);
    expect(p?.paidUsersCount).toBe(1);

    const updated = await referrals.findOne({ where: { referredUserId } });
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
    const after = await partners.findOne({ where: { id: partner.id } });
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
    expect(
      await referrals.findOne({ where: { referredUserId: userId } }),
    ).toBeNull();
  });
});
