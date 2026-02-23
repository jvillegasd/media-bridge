/**
 * Generic concurrent worker pool for parallel task execution.
 *
 * Shared between BasePlaylistHandler (fragment downloads with progress)
 * and HlsRecordingHandler (live segment downloads without progress tracking).
 */

export interface ConcurrentWorkersOptions<T> {
  /** Items to process */
  items: T[];
  /** Max concurrent workers */
  maxConcurrent: number;
  /** Process a single item. Throwing aborts this worker but not others. */
  processItem: (item: T) => Promise<void>;
  /** Optional: called when an item fails after processItem throws */
  onError?: (item: T, error: Error) => void;
  /** Optional: check before each item to bail early */
  shouldStop?: () => boolean;
}

/**
 * Process items concurrently with a shared-index worker pool.
 * Returns the list of errors encountered (empty on full success).
 */
export async function runConcurrentWorkers<T>(
  options: ConcurrentWorkersOptions<T>,
): Promise<Error[]> {
  const { items, maxConcurrent, processItem, onError, shouldStop } = options;
  let idx = 0;
  const errors: Error[] = [];

  const worker = async (): Promise<void> => {
    while (idx < items.length) {
      if (shouldStop?.()) return;
      const item = items[idx++]!;
      try {
        await processItem(item);
      } catch (err) {
        const e = err instanceof Error ? err : new Error(String(err));
        errors.push(e);
        onError?.(item, e);
      }
    }
  };

  const workers = Array.from(
    { length: Math.min(maxConcurrent, items.length) },
    () => worker(),
  );
  await Promise.allSettled(workers);

  return errors;
}
