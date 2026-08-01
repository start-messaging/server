/**
 * Redacts sensitive fields before an object reaches a log sink.
 *
 * This runs on every request body the logging interceptor emits, and those go
 * to stdout *and* to the OTEL exporter, so anything missed here leaves the
 * system entirely and cannot be recalled. The bias is therefore deliberately
 * towards over-redaction: a field wrongly masked costs a debugging session, a
 * field wrongly logged costs a regulated data breach.
 */

/**
 * Matched as substrings of the lowercased key, so `refreshToken`,
 * `x-api-key` and `bankAccountNumber` are all covered by one entry each.
 */
const SENSITIVE_SUBSTRINGS = [
  'password',
  'token',
  'secret',
  'apikey',
  'api_key',
  'authorization',
  'cvv',
  'otp',
  'card_number',
  'cardnumber',
  // Partner payout details. A partner's bank account number, IFSC and the
  // account holder's name are submitted together by PATCH
  // /partner/payout-details; none of them matched the previous list, so all
  // three were being written to stdout and shipped to analytics verbatim.
  'bankaccount',
  'accountnumber',
  'ifsc',
  'upiid',
  // Contact details are personal data even though they are not credentials.
  'phone',
];

/**
 * Matched against the whole lowercased key.
 *
 * `pan` is India's tax identifier and is only three characters, so it cannot
 * go in the substring list — it would silently redact ordinary keys such as
 * `expanded` or `panel` and make unrelated logs unreadable.
 */
const SENSITIVE_EXACT = ['pan', 'upi', 'ssn', 'aadhaar', 'aadhar'];

const REDACTED = '[REDACTED]';

function isSensitiveKey(key: string): boolean {
  const lower = key.toLowerCase();
  return (
    SENSITIVE_EXACT.includes(lower) ||
    SENSITIVE_SUBSTRINGS.some((field) => lower.includes(field))
  );
}

export function maskSensitiveData(data: unknown): unknown {
  if (!data || typeof data !== 'object') {
    return data;
  }

  if (Array.isArray(data)) {
    return data.map((item) => maskSensitiveData(item));
  }

  const masked: Record<string, unknown> = {
    ...(data as Record<string, unknown>),
  };

  for (const key of Object.keys(masked)) {
    if (isSensitiveKey(key)) {
      masked[key] = REDACTED;
    } else if (typeof masked[key] === 'object') {
      masked[key] = maskSensitiveData(masked[key]);
    }
  }

  return masked;
}
