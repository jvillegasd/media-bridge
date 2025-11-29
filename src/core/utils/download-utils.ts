/**
 * Utility functions for download operations
 */

import { DownloadStage } from "../types";

/**
 * Check if a download can be cancelled based on its current stage
 * Downloads in MERGING or SAVING stages cannot be cancelled because:
 * - Chunks are already downloaded and processing is in progress
 * - Cancellation would waste resources without benefit
 * 
 * @param stage - The current download stage
 * @returns true if the download can be cancelled, false otherwise
 */
export function canCancelDownload(stage: DownloadStage): boolean {
  // Completed, failed, or cancelled downloads cannot be cancelled
  if (
    stage === DownloadStage.COMPLETED ||
    stage === DownloadStage.FAILED ||
    stage === DownloadStage.CANCELLED
  ) {
    return false;
  }
  
  // Merging and saving stages cannot be cancelled
  // Chunks are already downloaded and processing is in progress
  if (
    stage === DownloadStage.MERGING ||
    stage === DownloadStage.SAVING
  ) {
    return false;
  }
  
  // DETECTING, DOWNLOADING, UPLOADING stages can be cancelled
  return true;
}

/**
 * Error message for when cancellation is prevented during merging/saving
 */
export const CANNOT_CANCEL_MESSAGE = 
  "Cannot cancel download during merging or saving phase. Chunks are already downloaded and processing is in progress.";

