import { APIResponse } from '@playwright/test';
import { sql } from '../helpers/db.js';
import { auth } from '../helpers/actors.js';

/**
 * Shared fixtures for the admin operations surface: dashboard, manual wallet
 * credits, tags, channels and OTP templates.
 *
 * admin/overview.spec.ts walks the happy path of these routes. The ops-*.spec.ts
 * files that import this module go after the seams instead — the wrong role, the
 * id that belongs to someone else, the amount with a slipped decimal, the second
 * click on a button that moves money, and the state machine behind
 * publish/unpublish.
 */

/** A well-formed uuid that is never issued to anything. */
export const NOWHERE = '00000000-0000-4000-8000-000000000000';

/**
 * Every row these specs create outside the truncated set carries this prefix.
 *
 * resetDb() truncates the tables the suite owns, and `tags`, `channels` and
 * `otp_templates` are deliberately not among them — the application seeds the
 * SMS channel and its system template on boot and self-heals them. So anything
 * created here has to be taken back out by hand, or a published test template
 * leaks into the customer-facing /templates list that later specs assert on.
 */
export const FIXTURE = 'e2e23-';

/** Registration grants this much, so no wallet in these specs starts at zero. */
export const WELCOME_CREDIT = 10;

export async function errorCode(res: APIResponse): Promise<string> {
  const body = (await res.json()) as { error?: { code?: string } };
  return body.error?.code ?? '(no error object)';
}

export async function errorMessage(res: APIResponse): Promise<string> {
  const body = (await res.json()) as { error?: { message?: string } };
  return body.error?.message ?? '';
}

/** The pagination envelope, which `payload()` unwraps away. */
export async function pagination(res: APIResponse) {
  const body = (await res.json()) as {
    pagination: {
      page: number;
      limit: number;
      totalItems: number;
      totalPages: number;
      hasNextPage: boolean;
    };
  };
  return body.pagination;
}

export async function balanceOf(userId: string): Promise<number> {
  const [row] = await sql<{ balance: string }>(
    `SELECT "balance" FROM "wallets" WHERE "userId" = $1`,
    [userId],
  );
  return Number(row?.balance ?? 0);
}

export async function removeFixtures(): Promise<void> {
  // Messages first: otpTemplateId is ON DELETE NO ACTION, so a message written
  // by the "template in use" test would block the template row from going.
  await sql(
    `DELETE FROM "messages"
      WHERE "otpTemplateId" IN (SELECT "id" FROM "otp_templates" WHERE "name" LIKE $1)`,
    [`${FIXTURE}%`],
  );
  await sql(`DELETE FROM "otp_templates" WHERE "name" LIKE $1`, [
    `${FIXTURE}%`,
  ]);
  await sql(`DELETE FROM "tags" WHERE "name" LIKE $1`, [`${FIXTURE}%`]);
  await sql(`DELETE FROM "channels" WHERE "name" LIKE $1`, [`${FIXTURE}%`]);
}

export const topup = (data: Record<string, unknown>, token: string) => ({
  data,
  headers: auth(token),
});
