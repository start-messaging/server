/** What a User-Agent string tells us about how the mail was read. */
export interface UserAgentDescription {
  /** Reading client: "Gmail", "Apple Mail", "Outlook", … */
  clientName: string | null;
  /** `desktop` | `mobile` | `tablet` | `proxy` | null */
  deviceType: string | null;
}

/**
 * Clients that fetch images on the recipient's behalf.
 *
 * These matter more than the rest of this file. Apple Mail Privacy Protection
 * pre-fetches every image in every message the moment it arrives, whether or
 * not anyone reads it — so an "open" from one of these is a machine, not a
 * person. Gmail proxies images too, though only once the message is actually
 * displayed, which is why it is classified as a real client and not a proxy.
 *
 * Recording the distinction is what lets the dashboard be honest about open
 * rates instead of quietly reporting Apple's prefetches as engagement.
 */
const PROXY_SIGNATURES: readonly RegExp[] = [
  /GoogleImageProxy/i,
  /YahooMailProxy/i,
  /Barracuda/i,
  /ProofpointURLDefense/i,
  /Symantec/i,
  /Mimecast/i,
];

const CLIENT_SIGNATURES: readonly { pattern: RegExp; name: string }[] = [
  { pattern: /GoogleImageProxy/i, name: 'Gmail' },
  { pattern: /YahooMailProxy/i, name: 'Yahoo Mail' },
  { pattern: /Outlook-iOS|Outlook-Android/i, name: 'Outlook Mobile' },
  { pattern: /Microsoft Outlook|MSOffice/i, name: 'Outlook' },
  { pattern: /Thunderbird/i, name: 'Thunderbird' },
  { pattern: /Superhuman/i, name: 'Superhuman' },
  { pattern: /Edge/i, name: 'Edge' },
  { pattern: /Firefox/i, name: 'Firefox' },
  { pattern: /Chrome/i, name: 'Chrome' },
  // Must come after Chrome and Edge: both include "Safari" in their UA.
  { pattern: /Safari/i, name: 'Safari' },
  { pattern: /Apple-?Mail|Mac OS X.*Mail/i, name: 'Apple Mail' },
];

/**
 * Classifies a User-Agent.
 *
 * A handful of regexes rather than a UA-parsing library on purpose. The full
 * libraries carry a large, frequently-updated device database to answer
 * questions this never asks — the dashboard groups opens into a few buckets,
 * and being wrong about an obscure client costs nothing.
 */
export function describeUserAgent(ua: string): UserAgentDescription {
  if (!ua) return { clientName: null, deviceType: null };

  const isProxy = PROXY_SIGNATURES.some((p) => p.test(ua));

  // Apple's prefetcher sends a plain desktop Safari/macOS string with no
  // distinguishing token, so it cannot be matched here — it is separated in
  // the dashboard by volume and timing instead, not by User-Agent.
  const client =
    CLIENT_SIGNATURES.find(({ pattern }) => pattern.test(ua))?.name ?? null;

  let deviceType: string | null = null;
  if (isProxy) {
    deviceType = 'proxy';
  } else if (/iPad|Tablet/i.test(ua)) {
    deviceType = 'tablet';
  } else if (/Mobile|iPhone|Android/i.test(ua)) {
    deviceType = 'mobile';
  } else if (/Macintosh|Windows|X11|Linux/i.test(ua)) {
    deviceType = 'desktop';
  }

  return { clientName: client, deviceType };
}
