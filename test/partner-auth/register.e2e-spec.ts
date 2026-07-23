import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from '../helpers/create-test-app';
import { unwrap, errorCode } from '../helpers/envelope';
import { uniqueEmail, DEFAULT_PASSWORD } from '../helpers/auth';

describe('POST /partner/auth/register', () => {
  let app: INestApplication;

  beforeAll(async () => {
    ({ app } = await createTestApp());
  });

  afterAll(async () => {
    await app.close();
  });

  it('registers a partner and returns a token pair + referral code', async () => {
    const email = uniqueEmail('reg');
    const res = await request(app.getHttpServer())
      .post('/partner/auth/register')
      .send({ email, password: DEFAULT_PASSWORD, fullName: 'Priya Sharma' })
      .expect(201);

    const data = unwrap<{
      accessToken: string;
      refreshToken: string;
      partner: {
        id: string;
        email: string;
        referralCode: string;
        commissionPercent: number;
        status: string;
      };
    }>(res.body);

    expect(typeof data.accessToken).toBe('string');
    expect(data.refreshToken).toContain('.');
    expect(data.partner.email).toBe(email.toLowerCase());
    expect(data.partner.referralCode).toMatch(/^[A-Z0-9]{8}$/);
    expect(data.partner.commissionPercent).toBe(10);
    expect(data.partner.status).toBe('active');
    // Credentials must never leak in the response.
    expect(JSON.stringify(res.body)).not.toContain('passwordHash');
  });

  it('rejects a duplicate email with 409 CONFLICT', async () => {
    const email = uniqueEmail('dup');
    await request(app.getHttpServer())
      .post('/partner/auth/register')
      .send({ email, password: DEFAULT_PASSWORD, fullName: 'First' })
      .expect(201);
    const res = await request(app.getHttpServer())
      .post('/partner/auth/register')
      .send({ email, password: DEFAULT_PASSWORD, fullName: 'Second' })
      .expect(409);
    expect(errorCode(res.body)).toBe('CONFLICT');
  });

  it('is case-insensitive on the email (duplicate in different case → 409)', async () => {
    const email = uniqueEmail('Case');
    await request(app.getHttpServer())
      .post('/partner/auth/register')
      .send({
        email: email.toLowerCase(),
        password: DEFAULT_PASSWORD,
        fullName: 'A',
      })
      .expect(201);
    await request(app.getHttpServer())
      .post('/partner/auth/register')
      .send({
        email: email.toUpperCase(),
        password: DEFAULT_PASSWORD,
        fullName: 'B',
      })
      .expect(409);
  });

  it('rejects a short password with 400 VALIDATION_ERROR', async () => {
    const res = await request(app.getHttpServer())
      .post('/partner/auth/register')
      .send({ email: uniqueEmail('weak'), password: 'short', fullName: 'X' })
      .expect(400);
    expect(errorCode(res.body)).toBe('VALIDATION_ERROR');
  });

  it('rejects an invalid email with 400', async () => {
    await request(app.getHttpServer())
      .post('/partner/auth/register')
      .send({
        email: 'not-an-email',
        password: DEFAULT_PASSWORD,
        fullName: 'X',
      })
      .expect(400);
  });
});
