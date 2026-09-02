/**
 * Shared fixtures for the platform specs.
 */

// The server's cookie is `partner_refresh_token` (PARTNER_REFRESH_COOKIE in
// partner-auth.service.ts). An earlier version of the partner session spec used
// `partner_refresh`, so every request in
// tests/e2e/platform/partner-session.spec.ts carried no cookie at all and the
// malformed-cookie test passed while exercising nothing.
export const PARTNER_REFRESH_COOKIE = 'partner_refresh_token';

export function partnerRefreshCookie(
  headers: Record<string, string>,
): string | null {
  const raw = headers['set-cookie'] ?? '';
  const match = new RegExp(`${PARTNER_REFRESH_COOKIE}=([^;]+)`).exec(raw);
  return match ? match[1] : null;
}
