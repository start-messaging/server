/**
 * Curated data for cold outreach.
 *
 * This was OUTREACH_CLICK_HOSTS. It is a security allowlist rather than a
 * setting: `/t/c` redirects a click to the host named in the link, and only
 * these hosts are permitted. In env, a typo or an accidental widening on one
 * box turns that route into an open redirect that nothing in review would see.
 * In code, changing it is a diff someone reads.
 */

/**
 * Hosts `/t/c` will redirect to. CSV so readers keep going through
 * `parseCsvList` for the same normalisation every other list here gets.
 */
export const CLICK_HOSTS_CSV =
  'startmessaging.com,www.startmessaging.com,app.startmessaging.com';
