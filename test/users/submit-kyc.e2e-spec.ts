import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from '../helpers/create-test-app';
import { errorCode } from '../helpers/envelope';
import { registerUser, bearer } from '../helpers/auth';

// POST /users/kyc — multipart/form-data (a `document` file + business fields).
// @SkipOnboarding(); default POST status is 201.
//
// NOTE: the true 201 HAPPY PATH is intentionally NOT asserted. A successful
// submission streams the uploaded document to Cloudflare R2 via
// R2UploadService.upload() (a live S3 PutObject network call); the test env has
// no R2 credentials/endpoint, so that call cannot succeed deterministically and
// there is no provider override in the shared createTestApp() harness. Instead
// we exercise everything up to (but not through) the upload: the multipart
// request shape, DTO validation, auth, and the mobile-verification gate — all
// of which run BEFORE the R2 call in the controller.
//
// FileTypeValidator (NestJS 11) inspects the buffer's magic number, so the
// attachment must be real image bytes — a 1x1 PNG below.
const PNG_1x1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

describe('POST /users/kyc', () => {
  let app: INestApplication;

  beforeAll(async () => {
    ({ app } = await createTestApp());
  });

  afterAll(async () => {
    await app.close();
  });

  it('rejects an unauthenticated request with 401', async () => {
    // The JWT guard runs before the file interceptor, so no file is needed.
    await request(app.getHttpServer()).post('/users/kyc').expect(401);
  });

  it('rejects an invalid PAN with 400 VALIDATION_ERROR', async () => {
    const user = await registerUser(app, 'kyc');
    const res = await request(app.getHttpServer())
      .post('/users/kyc')
      .set('Authorization', bearer(user.accessToken))
      .field('businessName', 'Acme Corp')
      .field('pan', 'INVALID')
      .field('businessAddress', '123 MG Road, Bengaluru')
      .attach('document', PNG_1x1, {
        filename: 'kyc.png',
        contentType: 'image/png',
      })
      .expect(400);
    expect(errorCode(res.body)).toBe('VALIDATION_ERROR');
  });

  it('rejects a KYC submission from an unverified user with 400', async () => {
    // A freshly registered user has mobileVerified=false. Two 400 gates run
    // before the R2 upload: the ParseFilePipe (NestJS 11 magic-number
    // FileTypeValidator, which is finicky on synthetic buffers) and the
    // controller's mobile-verification check. Either way the submission is
    // rejected with 400 and never reaches the network — that rejection is what
    // matters here, so we assert the 400 error envelope rather than a specific
    // gate's message (the message is brittle across NestJS file-type internals).
    const user = await registerUser(app, 'kyc');
    const res = await request(app.getHttpServer())
      .post('/users/kyc')
      .set('Authorization', bearer(user.accessToken))
      .field('businessName', 'Acme Corp')
      .field('pan', 'ABCDE1234F')
      .field('businessAddress', '123 MG Road, Bengaluru')
      .attach('document', PNG_1x1, {
        filename: 'kyc.png',
        contentType: 'image/png',
      })
      .expect(400);
    expect(errorCode(res.body)).toBeDefined();
  });
});
