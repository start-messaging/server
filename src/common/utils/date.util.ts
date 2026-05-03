/** India Standard Time is permanently UTC+05:30 (no DST). */
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

/**
 * Returns midnight IST as a UTC Date, optionally shifted back by `daysAgo` days.
 * e.g. istDayStart(0) → today 00:00 IST in UTC
 *      istDayStart(7) → 7 days ago 00:00 IST in UTC
 */
export function istDayStart(daysAgo = 0): Date {
  const nowIST = new Date(Date.now() + IST_OFFSET_MS);
  nowIST.setUTCHours(0, 0, 0, 0);
  if (daysAgo) nowIST.setUTCDate(nowIST.getUTCDate() - daysAgo);
  return new Date(nowIST.getTime() - IST_OFFSET_MS);
}

/**
 * Interprets a YYYY-MM-DD string as an IST calendar date and returns
 * midnight IST for that date as a UTC Date.
 */
export function parseISTDate(dateString: string): Date {
  const utcMidnight = new Date(`${dateString}T00:00:00.000Z`);
  return new Date(utcMidnight.getTime() - IST_OFFSET_MS);
}
