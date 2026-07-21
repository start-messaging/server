import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from '../helpers/create-test-app';
import { unwrap, errorCode } from '../helpers/envelope';
import { uniqueEmail, DEFAULT_PASSWORD } from '../helpers/auth';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Wallet } from '../../src/wallet/entities/wallet.entity';
import { Repository } from 'typeorm';

describe('POST /auth/register', () => {
  let app: INestApplication;

  beforeAll(async () => {
    ({ app } = await createTestApp());
  });

  afterAll(async () => {
    await app.close();
  });

  it('registers a user, returns a token, and credits a ₹10 welcome bonus (micros)', async () => {
    const email = uniqueEmail('signup');
    const res = await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email, password: DEFAULT_PASSWORD, firstName: 'A', lastName: 'B' })
      .expect(201);

    const data = unwrap<{
      accessToken: string;
      user: { id: string; email: string; role: string };
    }>(res.body);
    expect(data.accessToken).toEqual(expect.any(String));
    expect(data.user.email).toBe(email);
    expect(data.user.role).toBe('customer');

    // Welcome credit is ₹10 = 10_000_000 micros.
    const wallets = app.get<Repository<Wallet>>(getRepositoryToken(Wallet));
    const wallet = await wallets.findOne({ where: { userId: data.user.id } });
    expect(Number(wallet?.balance)).toBe(10_000_000);
  });

  it('rejects a duplicate email with 409', async () => {
    const email = uniqueEmail('dup');
    const body = {
      email,
      password: DEFAULT_PASSWORD,
      firstName: 'A',
      lastName: 'B',
    };
    await request(app.getHttpServer())
      .post('/auth/register')
      .send(body)
      .expect(201);
    await request(app.getHttpServer())
      .post('/auth/register')
      .send(body)
      .expect(409);
  });

  it('rejects invalid input with 400 VALIDATION_ERROR', async () => {
    const res = await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email: 'not-an-email', password: '123' })
      .expect(400);
    expect(errorCode(res.body)).toBe('VALIDATION_ERROR');
  });
});
