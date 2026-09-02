import { APIResponse } from '@playwright/test';

/**
 * Shared fixtures for the admin user-management and KYC surface, at its seams.
 *
 * admin/overview.spec.ts establishes that these routes work and that the role check
 * holds. The specs that import this module are about what happens either side
 * of that: the id that belongs to nobody, the value one type away from the one
 * the DTO expects, the review that arrives twice, and the identity document
 * that must never leave the building.
 */

/** A well-formed v4 UUID that belongs to no row in any table. */
export const GHOST_ID = '00000000-0000-4000-8000-000000000000';

/**
 * The `{ code, message }` half of the error envelope.
 *
 * Every failure in this API is `{ success:false, ..., error: { code, message } }`,
 * so tests assert on `code` — the message is prose and changes.
 */
export async function errorOf(
  res: APIResponse,
): Promise<{ code: string; message: string }> {
  const body = (await res.json()) as {
    error?: { code: string; message: string };
  };
  return body.error ?? { code: '<no error object>', message: await res.text() };
}

/** Pagination meta lives beside `data` on the envelope, not inside it. */
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
