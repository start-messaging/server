/**
 * Runs `worker` over `items` with at most `limit` in flight at once.
 *
 * The leads pipeline's in-process concurrency primitive (liveness probes,
 * the enrichment drain): work that is many small outbound requests gains
 * nothing from being fanned out through Redis as per-item jobs — the queue
 * bookkeeping would outweigh the work — but must still be bounded so a batch
 * of thousands cannot open thousands of sockets at once.
 *
 * The worker must do its own error handling; a rejection here would abandon
 * the remaining items, so callers wrap per-item failures into results.
 */
export async function runPool<T>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  const bound = Math.max(1, limit);
  const executing = new Set<Promise<void>>();
  for (const item of items) {
    const task = worker(item).finally(() => {
      executing.delete(task);
    });
    executing.add(task);
    if (executing.size >= bound) await Promise.race(executing);
  }
  await Promise.all(executing);
}
