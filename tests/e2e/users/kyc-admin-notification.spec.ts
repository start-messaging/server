import { test, expect } from '@playwright/test';
import { resetDb, closeDb, sql } from '../helpers/db.js';
import { createAdmin, createCustomer, Customer } from '../helpers/actors.js';
import { submitKyc } from './helpers.js';
import { startR2FixtureServer } from '../helpers/r2-fixture.js';

/**
 * KYC submission notifies the reviewers — and must never depend on it.
 *
 * The notification added a database read and a fan-out of Mailgun calls to a
 * path that previously only wrote a row. What these specs protect is the
 * customer's half of that bargain: whatever the admin roster happens to look
 * like, the submission still succeeds and still persists.
 *
 * Delivery itself is deliberately not asserted. The test environment ships no
 * MAILGUN_API_KEY, so `sendEmail` returns false before any network call — which
 * is precisely the state worth pinning down, because it is also what a real
 * Mailgun outage looks like from inside `submitKyc`. A send that cannot happen
 * must still leave a committed submission behind.
 */
test.describe('KYC submission — reviewer notification (R2 fixture on 41101)', () => {
  let applicant: Customer;
  let r2: Awaited<ReturnType<typeof startR2FixtureServer>>;

  // `/users/kyc` streams the document to R2 for real, so without the fixture
  // every submission here fails on the upload and proves nothing about the
  // notification. Port 41101 is shared serially with the admin KYC spec, which
  // is why afterAll must close it.
  test.beforeAll(async () => {
    r2 = await startR2FixtureServer();
  });

  /** `/users/kyc` is gated on a verified mobile, which is not what is under test. */
  async function clearTheGate(user: Customer) {
    await sql(`UPDATE "users" SET "mobileVerified" = true WHERE "id" = $1`, [
      user.id,
    ]);
  }

  /** What the customer is owed regardless of who does or does not get emailed. */
  async function expectSubmissionPersisted(user: Customer) {
    const [row] = await sql<{
      kycStatus: string;
      kycSubmittedAt: string | null;
      businessName: string | null;
    }>(
      `SELECT "kycStatus", "kycSubmittedAt", "businessName"
         FROM "users" WHERE "id" = $1`,
      [user.id],
    );
    expect(row.kycStatus).toBe('pending');
    expect(row.kycSubmittedAt).not.toBeNull();
    expect(row.businessName).toBe('Sangwan Traders');
  }

  test.beforeEach(async ({ request }) => {
    await resetDb();
    r2.objects.clear();
    applicant = await createCustomer(request);
    await clearTheGate(applicant);
  });

  test.afterAll(async () => {
    await r2.close();
    await closeDb();
  });

  test('succeeds with one active admin to notify', async ({ request }) => {
    await createAdmin(request);

    const res = await submitKyc(request, applicant.accessToken);

    expect(res.status(), await res.text()).toBe(201);
    await expectSubmissionPersisted(applicant);
  });

  test('succeeds when there are several admins to fan out to', async ({
    request,
  }) => {
    await createAdmin(request);
    await createAdmin(request);
    await createAdmin(request);

    const res = await submitKyc(request, applicant.accessToken);

    expect(res.status(), await res.text()).toBe(201);
    await expectSubmissionPersisted(applicant);
  });

  /**
   * The empty-roster branch. A fresh environment has no admin at all, and the
   * notification must treat that as "nobody to tell" rather than as an error on
   * the customer's request.
   */
  test('succeeds when no admin account exists', async ({ request }) => {
    const [{ count }] = await sql<{ count: string }>(
      `SELECT count(*)::text AS count FROM "users" WHERE "role" = 'admin'`,
    );
    expect(count).toBe('0');

    const res = await submitKyc(request, applicant.accessToken);

    expect(res.status(), await res.text()).toBe(201);
    await expectSubmissionPersisted(applicant);
  });

  /**
   * Deactivated admins are filtered out of the recipient list, so an
   * environment whose only admin has been switched off lands on the same
   * empty-roster branch as one that never had an admin. Worth its own case:
   * `isActive` is the difference between "nobody to tell" and a send attempt
   * against a retired mailbox.
   */
  test('succeeds when the only admin is deactivated', async ({ request }) => {
    const admin = await createAdmin(request);
    await sql(`UPDATE "users" SET "isActive" = false WHERE "id" = $1`, [
      admin.id,
    ]);

    const res = await submitKyc(request, applicant.accessToken);

    expect(res.status(), await res.text()).toBe(201);
    await expectSubmissionPersisted(applicant);
  });

  /**
   * Resubmission after a rejection goes through the same notification, because a
   * corrected submission needs reviewing exactly as much as a first one. The
   * guard here is that the second pass does not fail on the row already holding
   * a `kycSubmittedAt`.
   */
  test('notifies again on resubmission after rejection', async ({ request }) => {
    await createAdmin(request);
    await submitKyc(request, applicant.accessToken);

    await sql(
      `UPDATE "users"
          SET "kycStatus" = 'rejected', "kycRejectionReason" = 'Blurred document'
        WHERE "id" = $1`,
      [applicant.id],
    );

    const res = await submitKyc(request, applicant.accessToken);

    expect(res.status(), await res.text()).toBe(201);
    await expectSubmissionPersisted(applicant);
    const [row] = await sql<{ kycRejectionReason: string | null }>(
      `SELECT "kycRejectionReason" FROM "users" WHERE "id" = $1`,
      [applicant.id],
    );
    expect(row.kycRejectionReason).toBeNull();
  });
});
