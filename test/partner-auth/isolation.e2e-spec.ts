import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from '../helpers/create-test-app';
import { registerUser, registerPartner, bearer } from '../helpers/auth';

/**
 * The two auth stacks must not cross over: a customer token can't reach a
 * partner route, and a partner token can't reach a customer route.
 */
describe('Partner ↔ customer auth isolation', () => {
  let app: INestApplication;

  beforeAll(async () => {
    ({ app } = await createTestApp());
  });

  afterAll(async () => {
    await app.close();
  });

  it('a customer token cannot access a partner route (401)', async () => {
    const customer = await registerUser(app, 'cust');
    await request(app.getHttpServer())
      .get('/partner/me')
      .set('Authorization', bearer(customer.accessToken))
      .expect(401);
  });

  it('a partner token cannot access a customer route (401)', async () => {
    const partner = await registerPartner(app, 'iso');
    await request(app.getHttpServer())
      .get('/wallet')
      .set('Authorization', bearer(partner.accessToken))
      .expect(401);
  });

  it('an unauthenticated partner route is 401', async () => {
    await request(app.getHttpServer()).get('/partner/me').expect(401);
  });
});
