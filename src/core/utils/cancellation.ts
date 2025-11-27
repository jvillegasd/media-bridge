/**
 * Utility functions for handling cancellation
 */

import { CancellationError } from "./errors";

/**
 * Wraps a promise to check for abort signal and throw CancellationError if aborted
 */
export async function cancelIfAborted<T>(
  promise: Promise<T>,
  abortSignal?: AbortSignal
): Promise<T> {
  if (abortSignal?.aborted) {
    throw new CancellationError();
  }
  
  return promise.then(
    (result) => {
      if (abortSignal?.aborted) {
        throw new CancellationError();
      }
      return result;
    },
    (error) => {
      if (abortSignal?.aborted) {
        throw new CancellationError();
      }
      throw error;
    }
  );
}

