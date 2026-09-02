import { releaseSuiteLock } from './suite-lock.js';

/**
 * Releases the one-suite-at-a-time lock taken in global-setup.
 *
 * Only for the tidy case. The lock is a session advisory lock, so a run that
 * is killed or crashes drops its connection and Postgres releases it anyway —
 * which is exactly why it was chosen over a row in a table.
 */
export default async function globalTeardown(): Promise<void> {
  await releaseSuiteLock();
}
