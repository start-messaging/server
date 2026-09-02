import { test, expect } from '@playwright/test';
import { resetDb, closeDb, sql } from '../helpers/db.js';
import {
  createAdmin,
  createCustomer,
  createPartner,
  auth,
  payload,
  Customer,
} from '../helpers/actors.js';
import { GHOST_ID, errorOf } from './users-kyc-helpers.js';
import { PNG_1X1, submitKyc } from '../users/helpers.js';
import { startR2FixtureServer } from '../helpers/r2-fixture.js';

/**
 * The admin KYC review surface, at its seams.
 *
 * admin/overview.spec.ts establishes that these routes work and that the role check
 * holds. This file is about what happens either side of that: the review that
 * arrives twice, and the identity document that must never leave the building.
 */

test.describe('admin KYC review', () => {
  let admin: Customer;
  let applicant: Customer;

  /**
   * A path that is deliberately not in our R2 bucket.
   *
   * The e2e environment points R2 at the local fixture on port 41101
   * (R2_PUBLIC_URL in .env.e2e), so extractKeyFromUrl refuses this foreign
   * host and the handler answers before any network call — which is exactly
   * the property under test. The streaming happy path lives in its own
   * describe below, with the fixture server running.
   */
  const FOREIGN_DOCUMENT =
    'https://kyc-document-must-not-leak.invalid/private/pan-card-scan.pdf';

  test.beforeEach(async ({ request }) => {
    await resetDb();
    admin = await createAdmin(request);
    applicant = await createCustomer(request);
    await sql(
      `UPDATE "users"
          SET "mobileVerified"  = true,
              "kycStatus"       = 'pending',
              "kycSubmittedAt"  = now(),
              "businessName"    = 'Applicant Traders',
              "pan"             = 'ABCDE1234F',
              "kycDocumentPath" = $2
        WHERE "id" = $1`,
      [applicant.id, FOREIGN_DOCUMENT],
    );
  });

  test.afterAll(async () => {
    await closeDb();
  });

  test('the review queue hides accounts that never submitted anything', async ({
    request,
  }) => {
    // The default queue is "things to review". The admin account itself has
    // never submitted, so it must not sit in the reviewer's inbox.
    const queue = await request.get('/admin/kyc', {
      headers: auth(admin.accessToken),
    });
    expect(queue.status(), await queue.text()).toBe(200);
    const rows = await payload<{ id: string }[]>(queue);
    expect(rows.map((u) => u.id)).toEqual([applicant.id]);

    // Asking for them explicitly still works — that branch is a filter, not
    // the same "hide" rule.
    const explicit = await request.get('/admin/kyc?status=not_submitted', {
      headers: auth(admin.accessToken),
    });
    const notSubmitted = await payload<{ id: string }[]>(explicit);
    expect(notSubmitted.map((u) => u.id)).toEqual([admin.id]);

    const bogus = await request.get('/admin/kyc?status=in_review', {
      headers: auth(admin.accessToken),
    });
    expect(bogus.status(), await bogus.text()).toBe(400);
    expect((await errorOf(bogus)).code).toBe('VALIDATION_ERROR');
  });

  test('a second approval is accepted and leaves the record approved', async ({
    request,
  }) => {
    // Double-submit: the reviewer clicks Approve, the request is slow, they
    // click again. There is no state guard on reviewKyc, so both land.
    const first = await request.patch(`/admin/kyc/${applicant.id}`, {
      data: { action: 'approve' },
      headers: auth(admin.accessToken),
    });
    expect(first.status(), await first.text()).toBe(200);

    const [afterFirst] = await sql<{ kycReviewedAt: Date }>(
      `SELECT "kycReviewedAt" FROM "users" WHERE "id" = $1`,
      [applicant.id],
    );

    const second = await request.patch(`/admin/kyc/${applicant.id}`, {
      data: { action: 'approve' },
      headers: auth(admin.accessToken),
    });
    expect(second.status(), await second.text()).toBe(200);

    const [row] = await sql<{
      kycStatus: string;
      kycReviewedBy: string;
      kycReviewedAt: Date;
      hasCompletedOnboarding: boolean;
    }>(
      `SELECT "kycStatus", "kycReviewedBy", "kycReviewedAt", "hasCompletedOnboarding"
         FROM "users" WHERE "id" = $1`,
      [applicant.id],
    );
    expect(row.kycStatus).toBe('approved');
    expect(row.hasCompletedOnboarding).toBe(true);
    // Whoever reviewed last owns the decision, and it is always attributable.
    expect(row.kycReviewedBy).toBe(admin.id);
    expect(new Date(row.kycReviewedAt).getTime()).toBeGreaterThanOrEqual(
      new Date(afterFirst.kycReviewedAt).getTime(),
    );
  });

  test('two concurrent approvals settle on a single approved record', async ({
    request,
  }) => {
    const [a, b] = await Promise.all([
      request.patch(`/admin/kyc/${applicant.id}`, {
        data: { action: 'approve' },
        headers: auth(admin.accessToken),
      }),
      request.patch(`/admin/kyc/${applicant.id}`, {
        data: { action: 'approve' },
        headers: auth(admin.accessToken),
      }),
    ]);
    expect(a.status(), await a.text()).toBe(200);
    expect(b.status(), await b.text()).toBe(200);

    const rows = await sql<{ kycStatus: string }>(
      `SELECT "kycStatus" FROM "users" WHERE "id" = $1`,
      [applicant.id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].kycStatus).toBe('approved');
  });

  test('a user who never submitted a document can be approved straight through the onboarding gate', async ({
    request,
  }) => {
    const walkIn = await createCustomer(request);

    // The gate is shut: no mobile verification, no KYC, nothing submitted.
    const before = await request.get('/messages', {
      headers: auth(walkIn.accessToken),
    });
    expect(before.status(), await before.text()).toBe(403);

    // reviewKyc reads no current state, so "approve" is legal from any
    // status — including one where there is nothing to look at. Pinned as
    // current behaviour; reported as a bug.
    const res = await request.patch(`/admin/kyc/${walkIn.id}`, {
      data: { action: 'approve' },
      headers: auth(admin.accessToken),
    });
    expect(res.status(), await res.text()).toBe(200);

    const [row] = await sql<{
      kycStatus: string;
      kycSubmittedAt: Date | null;
      kycDocumentPath: string | null;
    }>(
      `SELECT "kycStatus", "kycSubmittedAt", "kycDocumentPath"
         FROM "users" WHERE "id" = $1`,
      [walkIn.id],
    );
    expect(row.kycStatus).toBe('approved');
    expect(row.kycSubmittedAt).toBeNull();
    expect(row.kycDocumentPath).toBeNull();

    // And the gate is now open for an account nobody ever verified.
    const after = await request.get('/messages', {
      headers: auth(walkIn.accessToken),
    });
    expect(
      after.status(),
      'approving an unsubmitted KYC no longer opens the gate — check the report',
    ).toBe(200);
  });

  test('rejecting an approved account leaves the completed-onboarding flag behind', async ({
    request,
  }) => {
    await request.patch(`/admin/kyc/${applicant.id}`, {
      data: { action: 'approve' },
      headers: auth(admin.accessToken),
    });

    // Revoking an approval is a legitimate operation — fraud is usually found
    // after the fact. What is not legitimate is the leftovers: reject writes
    // kycStatus and the reason, and never unwinds hasCompletedOnboarding.
    const res = await request.patch(`/admin/kyc/${applicant.id}`, {
      data: { action: 'reject', rejectionReason: 'documents were forged' },
      headers: auth(admin.accessToken),
    });
    expect(res.status(), await res.text()).toBe(200);

    const [row] = await sql<{
      kycStatus: string;
      kycRejectionReason: string;
      hasCompletedOnboarding: boolean;
    }>(
      `SELECT "kycStatus", "kycRejectionReason", "hasCompletedOnboarding"
         FROM "users" WHERE "id" = $1`,
      [applicant.id],
    );
    expect(row.kycStatus).toBe('rejected');
    expect(row.kycRejectionReason).toBe('documents were forged');
    expect(
      row.hasCompletedOnboarding,
      'hasCompletedOnboarding is now unwound on rejection — check the report',
    ).toBe(true);

    // The gate itself keys on kycStatus, so the customer really is stopped.
    const gated = await request.get('/messages', {
      headers: auth(applicant.accessToken),
    });
    expect(gated.status(), await gated.text()).toBe(403);
  });

  test('approving after a rejection leaves the old rejection reason on the record', async ({
    request,
  }) => {
    await request.patch(`/admin/kyc/${applicant.id}`, {
      data: { action: 'reject', rejectionReason: 'PAN card image was blurry' },
      headers: auth(admin.accessToken),
    });

    const res = await request.patch(`/admin/kyc/${applicant.id}`, {
      data: { action: 'approve' },
      headers: auth(admin.accessToken),
    });
    expect(res.status(), await res.text()).toBe(200);

    const [row] = await sql<{
      kycStatus: string;
      kycRejectionReason: string | null;
    }>(
      `SELECT "kycStatus", "kycRejectionReason" FROM "users" WHERE "id" = $1`,
      [applicant.id],
    );
    expect(row.kycStatus).toBe('approved');
    // submitKyc clears the reason on resubmission, but the approve branch
    // never does — so an account approved on a second look still carries the
    // sentence explaining why it was refused. Pinned; reported as a bug.
    expect(
      row.kycRejectionReason,
      'the approve branch now clears kycRejectionReason — check the report',
    ).toBe('PAN card image was blurry');
  });

  test('a rejection with no reason at all is accepted, an empty one is not', async ({
    request,
  }) => {
    // ReviewKycDto carries both @ValidateIf(action === 'reject') and
    // @IsOptional. @IsOptional wins for an absent value, so the "Rejection
    // reason is required when rejecting" message can never fire for the case
    // it was written for: the field simply missing.
    const missing = await request.patch(`/admin/kyc/${applicant.id}`, {
      data: { action: 'reject' },
      headers: auth(admin.accessToken),
    });
    expect(
      missing.status(),
      'a reasonless rejection is now refused — check the report',
    ).toBe(200);

    const [row] = await sql<{
      kycStatus: string;
      kycRejectionReason: string | null;
    }>(
      `SELECT "kycStatus", "kycRejectionReason" FROM "users" WHERE "id" = $1`,
      [applicant.id],
    );
    expect(row.kycStatus).toBe('rejected');
    // The customer is shown "why was I rejected?" and there is nothing there.
    expect(row.kycRejectionReason).toBeNull();

    // Spelled out as an empty string it does fire.
    const empty = await request.patch(`/admin/kyc/${applicant.id}`, {
      data: { action: 'reject', rejectionReason: '' },
      headers: auth(admin.accessToken),
    });
    expect(empty.status(), await empty.text()).toBe(400);
    expect((await errorOf(empty)).code).toBe('VALIDATION_ERROR');

    // Whitespace passes @IsNotEmpty and is stored verbatim, which is the same
    // hole one keystroke wider.
    const blank = await request.patch(`/admin/kyc/${applicant.id}`, {
      data: { action: 'reject', rejectionReason: '   ' },
      headers: auth(admin.accessToken),
    });
    expect(blank.status(), await blank.text()).toBe(200);
    const [blanked] = await sql<{ kycRejectionReason: string }>(
      `SELECT "kycRejectionReason" FROM "users" WHERE "id" = $1`,
      [applicant.id],
    );
    expect(blanked.kycRejectionReason).toBe('   ');
  });

  test('an action outside the enum changes nothing', async ({ request }) => {
    const bad: unknown[] = [
      'approved',
      'APPROVE',
      ' approve',
      'delete',
      '',
      null,
      1,
      ['approve'],
    ];

    for (const action of bad) {
      const res = await request.patch(`/admin/kyc/${applicant.id}`, {
        data: { action },
        headers: auth(admin.accessToken),
      });
      expect(res.status(), `action=${JSON.stringify(action)}`).toBe(400);
      expect((await errorOf(res)).code).toBe('VALIDATION_ERROR');
    }

    // A missing action is the same thing: the DTO has no default verdict.
    const absent = await request.patch(`/admin/kyc/${applicant.id}`, {
      data: { rejectionReason: 'no action given' },
      headers: auth(admin.accessToken),
    });
    expect(absent.status(), await absent.text()).toBe(400);

    const [row] = await sql<{ kycStatus: string; kycReviewedAt: Date | null }>(
      `SELECT "kycStatus", "kycReviewedAt" FROM "users" WHERE "id" = $1`,
      [applicant.id],
    );
    expect(row.kycStatus).toBe('pending');
    expect(row.kycReviewedAt).toBeNull();
  });

  test('the KYC document is never served to a non-admin, and no path leaks in the refusal', async ({
    request,
  }) => {
    const other = await createCustomer(request);
    const partner = await createPartner(request);

    const callers: [string, Record<string, string>, number][] = [
      ['anonymous', {}, 401],
      // The document is the applicant's own PAN card, and they still cannot
      // pull it from the admin route — this endpoint is the reviewer's, not
      // the subject's.
      ['the applicant themselves', auth(applicant.accessToken), 403],
      ['another customer', auth(other.accessToken), 403],
      ['a partner', auth(partner.accessToken), 401],
    ];

    for (const [who, headers, expected] of callers) {
      const res = await request.get(`/admin/kyc/${applicant.id}/document`, {
        headers,
      });
      expect(res.status(), `${who} reached the document route`).toBe(expected);

      const text = await res.text();
      // Not just "no bytes" — no pointer to the bytes either. A refusal that
      // echoes the object URL is the same leak one request later.
      expect(text, `${who} was shown the document path`).not.toContain(
        'kyc-document-must-not-leak.invalid',
      );
      expect(text).not.toContain('pan-card-scan');
      expect(text).not.toContain('ABCDE1234F');
    }

    // The same applies to the KYC detail record, which carries the path.
    const detail = await request.get(`/admin/kyc/${applicant.id}`, {
      headers: auth(other.accessToken),
    });
    expect(detail.status()).toBe(403);
    expect(await detail.text()).not.toContain('kyc-document-must-not-leak');

    // And an admin genuinely does get the path in the detail record — the
    // point is the audience, not the field.
    const asAdmin = await request.get(`/admin/kyc/${applicant.id}`, {
      headers: auth(admin.accessToken),
    });
    const record = await payload<{ kycDocumentPath: string }>(asAdmin);
    expect(record.kycDocumentPath).toBe(FOREIGN_DOCUMENT);
  });

  test('a document stored outside our own bucket is refused rather than fetched', async ({
    request,
  }) => {
    // extractKeyFromUrl only accepts paths under the configured public URL.
    // Anything else — a hand-edited row, a migrated legacy path, an attacker
    // who got a write in — must not turn this endpoint into a proxy that
    // fetches whatever URL the row names.
    const res = await request.get(`/admin/kyc/${applicant.id}/document`, {
      headers: auth(admin.accessToken),
    });
    expect(res.status(), await res.text()).toBe(404);
    expect((await errorOf(res)).code).toBe('NOT_FOUND');
    expect(await res.text()).not.toContain(
      'kyc-document-must-not-leak.invalid',
    );
  });

  test('the KYC record carries the admin-only columns and no password material', async ({
    request,
  }) => {
    // findByIdForAdmin widens the default projection with two select:false
    // columns. The reviewer needs those; nobody needs the credential columns,
    // and excludePassword is the only thing standing between the entity and
    // the wire.
    await request.patch(`/admin/users/${applicant.id}`, {
      data: { adminCallNotes: 'chased for a clearer PAN scan' },
      headers: auth(admin.accessToken),
    });

    const detail = await request.get(`/admin/kyc/${applicant.id}`, {
      headers: auth(admin.accessToken),
    });
    expect(detail.status(), await detail.text()).toBe(200);

    const record = await payload<Record<string, unknown>>(detail);
    expect(record.adminCallNotes).toBe('chased for a clearer PAN scan');
    expect(record).not.toHaveProperty('passwordHash');
    expect(record).not.toHaveProperty('refreshTokenHash');
    expect(record).not.toHaveProperty('mobileOtpHash');

    const queue = await request.get('/admin/kyc', {
      headers: auth(admin.accessToken),
    });
    const text = await queue.text();
    expect(text).not.toContain('passwordHash');
    expect(text).not.toContain('refreshTokenHash');
    // A bcrypt digest anywhere in either response means a projection widened
    // without anyone noticing.
    expect(text).not.toMatch(/\$2[aby]\$/);
    expect(await detail.text()).not.toMatch(/\$2[aby]\$/);
  });

  test('an unknown user and a user with no document are indistinguishable', async ({
    request,
  }) => {
    await sql(`UPDATE "users" SET "kycDocumentPath" = NULL WHERE "id" = $1`, [
      applicant.id,
    ]);

    const noDocument = await request.get(
      `/admin/kyc/${applicant.id}/document`,
      { headers: auth(admin.accessToken) },
    );
    const noUser = await request.get(`/admin/kyc/${GHOST_ID}/document`, {
      headers: auth(admin.accessToken),
    });

    expect(noDocument.status()).toBe(404);
    expect(noUser.status()).toBe(404);
    // Compared on the error object alone: requestId and timestamp differ by
    // design. Two distinguishable 404s here would turn this route into an
    // oracle for "is this person a customer of ours?".
    expect(await errorOf(noUser)).toEqual(await errorOf(noDocument));
  });
});

/**
 * The streaming happy path, previously untestable: it needs a real object
 * behind the configured public URL. The R2 fixture on port 41101 (see
 * tests/e2e/helpers/r2-fixture.ts; the leads fixtures own 41100) stores what
 * the submission PUT and serves it back to the admin route's GET.
 */
test.describe('admin KYC document streaming (R2 fixture on 41101)', () => {
  let admin: Customer;
  let applicant: Customer;
  let r2: Awaited<ReturnType<typeof startR2FixtureServer>>;

  test.beforeAll(async () => {
    r2 = await startR2FixtureServer();
  });

  test.afterAll(async () => {
    // MUST close: the port is shared serially with the users KYC spec.
    await r2.close();
    await closeDb();
  });

  test.beforeEach(async ({ request }) => {
    await resetDb();
    r2.objects.clear();
    admin = await createAdmin(request);
    applicant = await createCustomer(request);
    // Step 1 done so the applicant can submit for real through the API.
    await sql(
      `UPDATE "users" SET "mobileVerified" = true, "mobileNumber" = '+919000000031'
        WHERE "id" = $1`,
      [applicant.id],
    );
  });

  test('the reviewer streams back the exact bytes the applicant submitted', async ({
    request,
  }) => {
    const submitted = await submitKyc(request, applicant.accessToken);
    expect(submitted.status(), await submitted.text()).toBe(201);

    const res = await request.get(`/admin/kyc/${applicant.id}/document`, {
      headers: auth(admin.accessToken),
    });
    expect(res.status(), await res.text()).toBe(200);

    // The pinned contract is what the code actually does: a same-origin
    // STREAM of the object through the API (admin.controller.ts pipes the R2
    // body) — not a redirect and not a presigned URL, so the bucket never
    // has to be reachable from a reviewer's browser. Content-Type and
    // Content-Length pass through from storage; Content-Disposition inline
    // renders the document in the tab rather than downloading a PAN card
    // onto the reviewer's disk by default.
    expect(res.headers()['content-type']).toBe('image/png');
    expect(res.headers()['content-disposition']).toBe('inline');
    expect(res.headers()['content-length']).toBe(String(PNG_1X1.length));
    expect((await res.body()).equals(PNG_1X1)).toBe(true);
  });
});
