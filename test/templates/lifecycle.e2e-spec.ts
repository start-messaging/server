import { INestApplication } from '@nestjs/common';
import { Repository } from 'typeorm';
import { getRepositoryToken } from '@nestjs/typeorm';
import request from 'supertest';
import { createTestApp } from '../helpers/create-test-app';
import { unwrap, errorCode } from '../helpers/envelope';
import { registerUser, createAdmin, bearer } from '../helpers/auth';
import { Channel } from '../../src/channels/entities/channel.entity';

const OTP_BODY = 'Your code is {{otp}}. Valid {{expiry}} min.';

describe('Templates — user authoring + admin review', () => {
  let app: INestApplication;
  let smsChannelId: string;

  beforeAll(async () => {
    ({ app } = await createTestApp());
    // The SMS channel is seeded on boot.
    const channels = app.get<Repository<Channel>>(getRepositoryToken(Channel));
    const sms = await channels.findOne({ where: { name: 'sms' } });
    smsChannelId = sms!.id;
  });

  afterAll(async () => {
    await app.close();
  });

  async function createDraft(token: string, name = 'My OTP') {
    const res = await request(app.getHttpServer())
      .post('/templates')
      .set('Authorization', bearer(token))
      .send({ name, body: OTP_BODY, channelId: smsChannelId })
      .expect(201);
    return unwrap<{ id: string; status: string; userId: string }>(res.body);
  }

  it('rejects a body without {{otp}} (400)', async () => {
    const user = await registerUser(app, 'tpl');
    const res = await request(app.getHttpServer())
      .post('/templates')
      .set('Authorization', bearer(user.accessToken))
      .send({ name: 'Bad', body: 'no placeholder', channelId: smsChannelId })
      .expect(400);
    expect(errorCode(res.body)).toBe('VALIDATION_ERROR');
  });

  it('runs the full draft → submit → approve lifecycle', async () => {
    const user = await registerUser(app, 'tpl');
    const draft = await createDraft(user.accessToken);
    expect(draft.status).toBe('draft');
    expect(draft.userId).toBe(user.id);

    // Submit for review.
    const submitted = await request(app.getHttpServer())
      .post(`/templates/${draft.id}/submit`)
      .set('Authorization', bearer(user.accessToken))
      .expect(201);
    expect(unwrap<{ status: string }>(submitted.body).status).toBe(
      'pending_review',
    );

    // Admin sees it in the review queue and approves with provider ids.
    const admin = await createAdmin(app);
    const approved = await request(app.getHttpServer())
      .patch(`/admin/templates/${draft.id}/approve`)
      .set('Authorization', bearer(admin.accessToken))
      .send({ metadata: { '2factor': 'OTP1' } })
      .expect(200);
    const ap = unwrap<{ status: string; metadata: Record<string, string> }>(
      approved.body,
    );
    expect(ap.status).toBe('approved');
    expect(ap.metadata['2factor']).toBe('OTP1');

    // Now it appears in the user's usable-templates list, alongside the system one.
    const avail = await request(app.getHttpServer())
      .get('/templates/available')
      .set('Authorization', bearer(user.accessToken))
      .expect(200);
    const list = unwrap<Array<{ id: string; name: string }>>(avail.body);
    expect(list.some((t) => t.id === draft.id)).toBe(true);
    expect(list.some((t) => t.name === 'Standard OTP')).toBe(true);
  });

  it('rejects a template with a reason the owner can see', async () => {
    const user = await registerUser(app, 'tpl');
    const draft = await createDraft(user.accessToken, 'Reject me');
    await request(app.getHttpServer())
      .post(`/templates/${draft.id}/submit`)
      .set('Authorization', bearer(user.accessToken))
      .expect(201);

    const admin = await createAdmin(app);
    await request(app.getHttpServer())
      .patch(`/admin/templates/${draft.id}/reject`)
      .set('Authorization', bearer(admin.accessToken))
      .send({ rejectionReason: 'Unregistered DLT id' })
      .expect(200);

    const res = await request(app.getHttpServer())
      .get(`/templates/${draft.id}`)
      .set('Authorization', bearer(user.accessToken))
      .expect(200);
    const t = unwrap<{ status: string; rejectionReason: string }>(res.body);
    expect(t.status).toBe('rejected');
    expect(t.rejectionReason).toBe('Unregistered DLT id');
  });

  it('scopes templates to their owner (cannot read another user’s template)', async () => {
    const a = await registerUser(app, 'owner');
    const b = await registerUser(app, 'other');
    const draft = await createDraft(a.accessToken, 'A private');

    await request(app.getHttpServer())
      .get(`/templates/${draft.id}`)
      .set('Authorization', bearer(b.accessToken))
      .expect(404);
  });

  it('requires authentication', async () => {
    await request(app.getHttpServer()).get('/templates').expect(401);
  });
});
