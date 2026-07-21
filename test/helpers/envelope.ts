/**
 * Helpers over the standard response envelope.
 *   success → { success: true, statusCode, data, pagination? }
 *   error   → { success: false, error: { code, message, details? } }
 */
export interface ErrorEnvelope {
  success: false;
  statusCode: number;
  error: { code: string; message: string; details?: unknown };
}

export function unwrap<T>(body: unknown): T {
  return (body as { data: T }).data;
}

export function pagination(
  body: unknown,
): { totalItems: number; page: number; totalPages: number } {
  return (body as { pagination: any }).pagination;
}

export function errorCode(body: unknown): string {
  return (body as ErrorEnvelope).error?.code;
}
