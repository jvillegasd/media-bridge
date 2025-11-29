/**
 * Utility functions for handling cancellation
 */

import { CancellationError } from "./errors";

/**
 * Throws CancellationError if the abort signal is aborted
 * Use for synchronous cancellation checks at key points in download flow
 * @param abortSignal - Optional abort signal to check
 * @throws {CancellationError} If the signal is aborted
 */
export function throwIfAborted(abortSignal?: AbortSignal): void {
  if (abortSignal?.aborted) {
    throw new CancellationError();
  }
}

/**
 * Wraps a promise to check for abort signal and throw CancellationError if aborted
 * Checks both before and after the promise resolves/rejects
 * @param promise - The promise to wrap
 * @param abortSignal - Optional abort signal to check
 * @returns The promise result if not aborted
 * @throws {CancellationError} If the signal is aborted
 */
export async function cancelIfAborted<T>(
  promise: Promise<T>,
  abortSignal?: AbortSignal
): Promise<T> {
  throwIfAborted(abortSignal);
  
  return promise.then(
    (result) => {
      throwIfAborted(abortSignal);
      return result;
    },
    (error) => {
      throwIfAborted(abortSignal);
      throw error;
    }
  );
}

