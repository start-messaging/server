import { INestApplication } from '@nestjs/common';
import { Repository } from 'typeorm';
import { getRepositoryToken } from '@nestjs/typeorm';
import request from 'supertest';
import { createTestApp } from '../helpers/create-test-app';
import { unwrap, errorCode } from '../helpers/envelope';
import {
  registerUser,
  registerPartner,
  createAdmin,
  bearer,
  RegisteredPartner,
} from '../helpers/auth';
import { freezeDate, isoForDayOfMonth } from '../helpers/clock';
import { ReferralPartner } from '../../src/referral/entities/referral-partner.entity';
import { PayoutStatus } from '../../src/referral/entities/payout-request.entity';

// Default window is days 21–28; min 10 paid users; min ₹1000 balance.
// Dates are computed within the current real month so tokens stay valid.
const INSIDE_WINDOW = isoForDayOfMonth(25);
const OUTSIDE_WINDOW = isoForDayOfMonth(10);

describe('Affiliate — payout window + thresholds', () => {
  let app: INestApplication;
  let partners: Repository<ReferralPartner>;

  beforeAll(async () => {
    ({ app } = await createTestApp());
    partners = app.get<Repository<ReferralPartner>>(
      getRepositoryToken(ReferralPartner),
    );
  });

  afterAll(async () => {
    await app.close();
  });

  /** Seed the cached balance + paid-users count directly on the partner row. */
  async function seed(
    partner: RegisteredPartner,
    paidUsersCount: number,
    earningsBalance: number,
  ) {
    await partners.update(
      { id: partner.id },
      { paidUsersCount, earningsBalance },
    );
  }

  it('blocks payout outside the 21–28 window', async () => {
    const partner = await registerPartner(app, 'pw');
    await seed(partner, 12, 2_000_000_000);
    const restore = freezeDate(OUTSIDE_WINDOW);
    try {
      const res = await request(app.getHttpServer())
        .post('/partner/payouts')
        .set('Authorization', bearer(partner.accessToken))
        .send({})
        .expect(403);
      expect(errorCode(res.body)).toBe('PAYOUT_WINDOW_CLOSED');
    } finally {
      restore();
    }
  });

  it('blocks payout below the paid-users threshold', async () => {
    const partner = await registerPartner(app, 'pt');
    await seed(partner, 3, 2_000_000_000);
    const restore = freezeDate(INSIDE_WINDOW);
    try {
      const res = await request(app.getHttpServer())
        .post('/partner/payouts')
        .set('Authorization', bearer(partner.accessToken))
        .send({})
        .expect(403);
      expect(errorCode(res.body)).toBe('PAYOUT_THRESHOLD_NOT_MET');
    } finally {
      restore();
    }
  });

  it('blocks payout below the minimum balance', async () => {
    const partner = await registerPartner(app, 'pb');
    await seed(partner, 12, 500_000_000); // ₹500 < ₹1000
    const restore = freezeDate(INSIDE_WINDOW);
    try {
      const res = await request(app.getHttpServer())
        .post('/partner/payouts')
        .set('Authorization', bearer(partner.accessToken))
        .send({})
        .expect(400);
      expect(errorCode(res.body)).toBe('PAYOUT_MIN_BALANCE_NOT_MET');
    } finally {
      restore();
    }
  });

  it('creates a payout when eligible and zeroes the balance; admin reject restores it', async () => {
    const partner = await registerPartner(app, 'pok');
    await seed(partner, 12, 2_000_000_000);
    const admin = await createAdmin(app);

    const restore = freezeDate(INSIDE_WINDOW);
    let payoutId: string;
    try {
      const res = await request(app.getHttpServer())
        .post('/partner/payouts')
        .set('Authorization', bearer(partner.accessToken))
        .send({})
        .expect(201);
      const payout = unwrap<{
        id: string;
        amountMicros: number;
        status: string;
      }>(res.body);
      payoutId = payout.id;
      expect(payout.amountMicros).toBe(2_000_000_000);
      expect(payout.status).toBe(PayoutStatus.REQUESTED);
    } finally {
      restore();
    }

    // Balance moved out atomically.
    const afterRequest = await partners.findOne({ where: { id: partner.id } });
    expect(Number(afterRequest?.earningsBalance)).toBe(0);

    // A second request while one is pending is rejected.
    const restore2 = freezeDate(INSIDE_WINDOW);
    try {
      // top the balance back up so only the pending-guard can block it
      await seed(partner, 12, 2_000_000_000);
      const dup = await request(app.getHttpServer())
        .post('/partner/payouts')
        .set('Authorization', bearer(partner.accessToken))
        .send({})
        .expect(400);
      expect(errorCode(dup.body)).toBe('PAYOUT_PENDING_EXISTS');
      await seed(partner, 12, 0);
    } finally {
      restore2();
    }

    // Admin rejects → funds returned via a reversal.
    const rej = await request(app.getHttpServer())
      .patch(`/admin/payouts/${payoutId!}/reject`)
      .set('Authorization', bearer(admin.accessToken))
      .send({ rejectionReason: 'Invalid UPI' })
      .expect(200);
    expect(unwrap<{ status: string }>(rej.body).status).toBe(
      PayoutStatus.REJECTED,
    );

    const restored = await partners.findOne({ where: { id: partner.id } });
    expect(Number(restored?.earningsBalance)).toBe(2_000_000_000);
  });

  it('lets an admin approve (mark paid) a payout', async () => {
    const partner = await registerPartner(app, 'pap');
    await seed(partner, 15, 1_500_000_000);
    const admin = await createAdmin(app);

    const restore = freezeDate(INSIDE_WINDOW);
    let payoutId: string;
    try {
      const res = await request(app.getHttpServer())
        .post('/partner/payouts')
        .set('Authorization', bearer(partner.accessToken))
        .send({})
        .expect(201);
      payoutId = unwrap<{ id: string }>(res.body).id;
    } finally {
      restore();
    }

    const approve = await request(app.getHttpServer())
      .patch(`/admin/payouts/${payoutId!}/approve`)
      .set('Authorization', bearer(admin.accessToken))
      .send({ payoutRef: 'UTR123' })
      .expect(200);
    const payout = unwrap<{ status: string; payoutRef: string }>(approve.body);
    expect(payout.status).toBe(PayoutStatus.PAID);
    expect(payout.payoutRef).toBe('UTR123');

    // Balance stays at 0 (already moved out at request time).
    const p = await partners.findOne({ where: { id: partner.id } });
    expect(Number(p?.earningsBalance)).toBe(0);
  });

  it('forbids a non-admin (customer) from listing partners', async () => {
    const user = await registerUser(app, 'nonadmin');
    await request(app.getHttpServer())
      .get('/admin/partners')
      .set('Authorization', bearer(user.accessToken))
      .expect(403);
  });
});
