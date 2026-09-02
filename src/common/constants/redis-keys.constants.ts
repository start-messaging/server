/**
 * The BullMQ key namespace, derived from REDIS_KEY_PREFIX.
 *
 * One literal, because two processes depend on the shape. The API hands it to
 * BullMQ at boot; the e2e db helpers spare exactly these keys when they clear
 * Redis between tests, and they run in the Playwright process, which never
 * boots Nest. Reconstructed independently, a change on one side leaves the
 * suite either deleting the queues its own API is working — workers then block
 * on a stream that no longer exists and the next spec times out on a webhook
 * that will never be processed — or sweeping nothing at all.
 *
 * Falls back to BullMQ's own default when the prefix is unset, so existing
 * queues keep their names and in-flight jobs are still found after a deploy.
 */
export function bullPrefix(keyPrefix?: string | null): string {
  return keyPrefix ? `${keyPrefix}:bull` : 'bull';
}

/**
 * The logical DB a REDIS_URL selects, as a number.
 *
 * `Number(pathname.slice(1)) || 0` used to swallow a typo — /db14, /abc and
 * /1x all resolved to db 0, which is the silent-wrong-database failure the
 * parse exists to end: a suite that believed it was alone on /14 would quietly
 * share the bare keyspace the dev API sits on and the two would steal each
 * other's jobs. Only an absent path or a bare "/" still means db 0, because
 * production and staging URLs carry no path and must keep resolving there.
 *
 * Shared because three processes parse the same URL and must agree: the API
 * hands the result to BullMQ, the e2e global setup sweeps that DB, and the
 * leads helper enqueues into it. A job written to a DB no worker reads fails
 * as a poll timeout with nothing naming the mismatch.
 */
export function redisLogicalDb(url: URL): number {
  const path = url.pathname;
  if (path !== '' && path !== '/' && !/^\/\d+$/.test(path)) {
    throw new Error(
      `REDIS_URL has a malformed logical DB path "${path}" — expected no ` +
        'path or /<digits>. A malformed path resolves to db 0, the shared ' +
        'keyspace this parse exists to keep queues out of.',
    );
  }
  return path.length > 1 ? Number(path.slice(1)) : 0;
}
