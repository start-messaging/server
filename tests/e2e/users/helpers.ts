import { APIRequestContext, APIResponse } from '@playwright/test';
import * as bcrypt from 'bcrypt';
import { sql } from '../helpers/db.js';
import { auth } from '../helpers/actors.js';

/**
 * Shared fixtures for the seven routes under /users — the surface every
 * signed-in account owns.
 *
 * The row readers below are the only place the truth lives for these specs;
 * the OTP helpers and the hand-built multipart body are what the mobile
 * verification and KYC state machines need in order to be driven at all.
 *
 * Errors are `{ code, message }`. The split worth knowing when reading the
 * assertions in the specs that import this module: a DTO rejection comes back
 * as VALIDATION_ERROR (the exception filter recognises class-validator's
 * message array), while a rule enforced inside UsersService is a plain
 * BadRequestException and lands as INVALID_INPUT.
 */

export interface UserRow {
  firstName: string;
  lastName: string;
  email: string;
  role: string;
  isActive: boolean;
  companyName: string | null;
  websiteUrl: string | null;
  country: string | null;
  mobileNumber: string | null;
  mobileVerified: boolean;
  kycStatus: string;
  businessName: string | null;
  pan: string | null;
  gstin: string | null;
  businessAddress: string | null;
  kycDocumentPath: string | null;
  kycSubmittedAt: Date | null;
  kycRejectionReason: string | null;
  hasCompletedOnboarding: boolean;
}

/** The row as the database holds it — the only place the truth lives. */
export async function userRow(id: string): Promise<UserRow> {
  const [row] = await sql<UserRow>(
    `SELECT "firstName", "lastName", "email", "role", "isActive",
            "companyName", "websiteUrl", "country", "mobileNumber",
            "mobileVerified", "kycStatus", "businessName", "pan",
            "gstin", "businessAddress",
            "kycDocumentPath", "kycSubmittedAt", "kycRejectionReason",
            "hasCompletedOnboarding"
       FROM "users" WHERE "id" = $1`,
    [id],
  );
  return row;
}

export interface OtpRow {
  id: string;
  phoneNumber: string;
  attempts: number;
  maxAttempts: number;
  verified: boolean;
}

export async function otpRows(userId: string): Promise<OtpRow[]> {
  return sql<OtpRow>(
    `SELECT "id", "phoneNumber", "attempts", "maxAttempts", "verified"
       FROM "mobile_otps" WHERE "userId" = $1 ORDER BY "createdAt" ASC`,
    [userId],
  );
}

/**
 * The machine-readable half of an error body.
 *
 * Asserting on `code` rather than the sentence keeps these tests alive when
 * someone rewords a message, and it is the only part of the contract a client
 * can branch on.
 */
export async function errorCode(res: APIResponse): Promise<string | undefined> {
  const body = (await res.json()) as { error?: { code?: string } };
  return body.error?.code;
}

/**
 * Rewrites a stored OTP hash so the test knows the code.
 *
 * The generated code is never returned by the API — by design — and the only
 * other way to learn it is to scrape it out of the console SMS provider's log
 * line, which ties the test to where the server's stdout happens to be
 * redirected. Replacing the hash exercises the same verification path
 * (expiry, attempt budget, verified flag, the write back to the user) without
 * that dependency.
 */
export async function forceOtpCode(
  userId: string,
  code: string,
): Promise<string> {
  const hash = await bcrypt.hash(code, 4);
  await sql(
    `UPDATE "mobile_otps" SET "otpHash" = $2
      WHERE "userId" = $1
        AND "id" = (SELECT "id" FROM "mobile_otps" WHERE "userId" = $1
                     ORDER BY "createdAt" DESC LIMIT 1)`,
    [userId, hash],
  );
  return code;
}

/** Valid Indian mobiles, distinct per call within a test. */
export function phone(suffix: number): string {
  return `+9198765${String(suffix).padStart(5, '0')}`;
}

export const BOUNDARY = 'e2eUsersKycBoundary';

/**
 * A real 1×1 PNG.
 *
 * Nest 11's FileTypeValidator inspects magic numbers through the `file-type`
 * package rather than trusting the declared mimetype, so a buffer of text
 * labelled `image/png` is refused. The KYC tests that need to get *past* the
 * file pipe therefore have to send genuine image bytes.
 */
export const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

/**
 * A real 1×1 GIF — genuinely well-formed bytes of a type the KYC allowlist
 * (pdf|jpg|jpeg|png) refuses. The counterpart to the fake-PNG test: that one
 * proves lying about the type fails, this one proves an honest-but-wrong type
 * fails too.
 */
export const GIF_1X1 = Buffer.from(
  'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
  'base64',
);

export interface UploadPart {
  field: string;
  filename: string;
  contentType: string;
  content: Buffer;
}

/**
 * Builds a multipart body by hand.
 *
 * Playwright's own `multipart` option cannot be used here: playwright.config
 * sets `Content-Type: application/json` as a default header for every request
 * in the suite, and Playwright only fills in the multipart content type when
 * one is not already set — so the boundary would never reach the server and
 * multer would see no file at all. Sending a pre-built buffer with an explicit
 * header is the one form the per-request header wins.
 */
export function multipartBody(
  fields: Record<string, string>,
  file?: UploadPart,
): Buffer {
  const parts: Buffer[] = [];
  for (const [name, value] of Object.entries(fields)) {
    parts.push(
      Buffer.from(
        `--${BOUNDARY}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
      ),
    );
  }
  if (file) {
    parts.push(
      Buffer.from(
        `--${BOUNDARY}\r\nContent-Disposition: form-data; name="${file.field}"; ` +
          `filename="${file.filename}"\r\nContent-Type: ${file.contentType}\r\n\r\n`,
      ),
    );
    parts.push(file.content);
    parts.push(Buffer.from('\r\n'));
  }
  parts.push(Buffer.from(`--${BOUNDARY}--\r\n`));
  return Buffer.concat(parts);
}

export const VALID_KYC = {
  businessName: 'Sangwan Traders',
  pan: 'ABCDE1234F',
  businessAddress: '221B Baker Street, Jaipur',
};

export function submitKyc(
  request: APIRequestContext,
  token: string,
  opts: {
    fields?: Record<string, string>;
    file?: UploadPart | null;
  } = {},
) {
  const file =
    opts.file === null
      ? undefined
      : (opts.file ?? {
          field: 'document',
          filename: 'kyc.png',
          contentType: 'image/png',
          content: PNG_1X1,
        });

  return request.post('/users/kyc', {
    data: multipartBody(opts.fields ?? VALID_KYC, file),
    headers: {
      ...auth(token),
      'Content-Type': `multipart/form-data; boundary=${BOUNDARY}`,
    },
  });
}
