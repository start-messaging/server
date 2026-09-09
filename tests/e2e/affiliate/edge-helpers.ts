import { APIRequestContext, APIResponse } from '@playwright/test';
import { sql } from '../helpers/db.js';

/**
 * Fixtures shared by the affiliate edge-case specs: partner-portal.spec.ts,
 * admin-affiliate.spec.ts and public-referral.spec.ts.
 *
 * The seams of the four affiliate controllers, after the rest of affiliate/ and
 * platform/partner-session have covered the flows themselves.
 *
 * Nothing here re-asserts a happy path. What is left once accrual, payouts,
 * remediation and attribution are pinned down is the edge: identifiers that
 * belong to somebody else or to nobody, enum values borrowed from a
 * neighbouring enum, numbers at their bounds, two admins pressing the same
 * button at once, and the unauthenticated click endpoint — the only affiliate
 * surface an anonymous caller can reach at all.
 */

/** A syntactically valid UUID that nothing in this schema will ever own. */
export const ABSENT_UUID = '00000000-0000-4000-8000-000000000000';

/**
 * The `{ code, message }` half of an error envelope.
 *
 * Asserting on `code` rather than prose is what keeps these tests from failing
 * when somebody rewords a message. ParseUUIDPipe and the DTO pipe answer with
 * different codes — INVALID_INPUT for the former (a plain string message),
 * VALIDATION_ERROR for the latter (an array) — and that distinction is itself
 * worth pinning: it tells the client whether the id or the body was wrong.
 */
export async function errorOf(
  res: APIResponse,
): Promise<{ code?: string; message?: string }> {
  const body = (await res.json()) as {
    error?: { code?: string; message?: string };
  };
  return body.error ?? {};
}

/** The `pagination` block that sits beside `data` on every list response. */
export async function meta(res: APIResponse) {
  const body = (await res.json()) as {
    pagination: {
      page: number;
      limit: number;
      totalItems: number;
      totalPages: number;
      hasNextPage: boolean;
      hasPreviousPage: boolean;
    };
  };
  return body.pagination;
}

/** True when the response set the attribution cookie. */
export function setsReferralCookie(res: APIResponse): boolean {
  return /sm_ref=/.test(res.headers()['set-cookie'] ?? '');
}

export function referralCookieValue(res: APIResponse): string | null {
  const match = /sm_ref=([^;]+)/.exec(res.headers()['set-cookie'] ?? '');
  return match ? match[1] : null;
}

export async function referralFor(userId: string) {
  const [row] = await sql<{ partnerId: string; status: string }>(
    `SELECT "partnerId", "status" FROM "referrals" WHERE "userId" = $1`,
    [userId],
  );
  return row ?? null;
}

export const track = (
  request: APIRequestContext,
  data: Record<string, unknown>,
) => request.post('/affiliate/track', { data });
