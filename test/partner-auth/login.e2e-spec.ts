import { INestApplication } from '@nestjs/common';
import { Repository } from 'typeorm';
import { getRepositoryToken } from '@nestjs/typeorm';
import request from 'supertest';
import { createTestApp } from '../helpers/create-test-app';
import { unwrap, errorCode } from '../helpers/envelope';
import { registerPartner, DEFAULT_PASSWORD, bearer } from '../helpers/auth';
import {
  ReferralPartner,
  ReferralPartnerStatus,
} from '../../src/referral/entities/referral-partner.entity';

describe('POST /partner/auth/login', () => {
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

  it('logs in with the right credentials and returns a working token', async () => {
    const partner = await registerPartner(app, 'login');
    const res = await request(app.getHttpServer())
      .post('/partner/auth/login')
      .send({ email: partner.email, password: DEFAULT_PASSWORD })
      .expect(200);
    const data = unwrap<{ accessToken: string }>(res.body);

    // The token actually authenticates a partner route.
    await request(app.getHttpServer())
      .get('/partner/me')
      .set('Authorization', bearer(data.accessToken))
      .expect(200);
  });

  it('rejects a wrong password with 401 INVALID_CREDENTIALS', async () => {
    const partner = await registerPartner(app, 'wrongpw');
    const res = await request(app.getHttpServer())
      .post('/partner/auth/login')
      .send({ email: partner.email, password: 'WrongPassword!1' })
      .expect(401);
    expect(errorCode(res.body)).toBe('INVALID_CREDENTIALS');
  });

  it('rejects an unknown email with 401 INVALID_CREDENTIALS', async () => {
    const res = await request(app.getHttpServer())
      .post('/partner/auth/login')
      .send({ email: 'nobody@nowhere.test', password: DEFAULT_PASSWORD })
      .expect(401);
    expect(errorCode(res.body)).toBe('INVALID_CREDENTIALS');
  });

  it('blocks a suspended partner with 403 PARTNER_SUSPENDED', async () => {
    const partner = await registerPartner(app, 'susp');
    await partners.update(
      { id: partner.id },
      { status: ReferralPartnerStatus.SUSPENDED },
    );
    const res = await request(app.getHttpServer())
      .post('/partner/auth/login')
      .send({ email: partner.email, password: DEFAULT_PASSWORD })
      .expect(403);
    expect(errorCode(res.body)).toBe('PARTNER_SUSPENDED');
  });
});
