/**
 * M3U8 media playlist download handler - orchestrates M3U8 media playlist video downloads
 *
 * This handler is responsible for downloading videos from standalone M3U8 media playlists.
 * Unlike HLS master playlists, media playlists contain a single stream (video+audio combined)
 * and don't require quality selection or stream merging.
 *
 * Key features:
 * - Downloads fragments from a single media playlist
 * - Handles AES-128 encrypted fragments (decryption)
 * - Stores fragments in IndexedDB for processing
 * - Processes fragments using FFmpeg via offscreen document
 * - Tracks download progress with byte-level accuracy and speed calculation
 * - Simpler than HLS handler (no master playlist parsing or stream merging)
 *
 * Download process:
 * 1. Parse media playlist to extract fragments
 * 2. Download all fragments with concurrency control
 * 3. Process fragments using FFmpeg (concatenate into MP4)
 * 4. Save final MP4 file using Chrome downloads API
 *
 * Note: This handler is used for standalone media playlists. For master playlists with
 * multiple quality variants, use HlsDownloadHandler instead.
 *
 * @module M3u8DownloadHandler
 */

import { CancellationError, DownloadError } from "../../utils/errors";
import { getDownload, storeDownload } from "../../database/downloads";
import { DownloadState, Fragment, DownloadStage } from "../../types";
import { logger } from "../../utils/logger";
import { decryptFragment } from "../../utils/crypto-utils";
import { fetchText, fetchArrayBuffer } from "../../utils/fetch-utils";
import { parseLevelsPlaylist } from "../../utils/m3u8-parser";
import { storeChunk, deleteChunks } from "../../database/chunks";
import { createOffscreenDocument } from "../../utils/offscreen-manager";
import { MessageType } from "../../../shared/messages";
import { cancelIfAborted, throwIfAborted } from "../../utils/cancellation";
import {
  DownloadProgressCallback,
  DownloadProgressCallback as ProgressCallback,
} from "../types";
import { hasDrm } from "../../utils/drm-utils";
import { sanitizeFilename } from "../../utils/file-utils";

/** Configuration options for M3U8 download handler */
export interface M3u8DownloadHandlerOptions {
  /** Optional callback for progress updates */
  onProgress?: DownloadProgressCallback;
  /** Maximum concurrent fragment downloads @default 3 */
  maxConcurrent?: number;
  /** FFmpeg processing timeout in milliseconds @default 900000 (15 minutes) */
  ffmpegTimeout?: number;
}

/**
 * M3U8 download handler for media playlists
 * Simpler than HLS handler - single stream, no quality selection or merging
 */
export class M3u8DownloadHandler {
  private readonly onProgress?: ProgressCallback;
  private readonly maxConcurrent: number;
  private readonly ffmpegTimeout: number;
  /** Download ID (same as stateId) */
  private downloadId: string = "";
  /** Total bytes downloaded across all fragments */
  private bytesDownloaded: number = 0;
  /** Estimated total bytes (updated as download progresses) */
  private totalBytes: number = 0;
  /** Timestamp of last progress update (for speed calculation) */
  private lastUpdateTime: number = 0;
  /** Bytes downloaded at last update (for speed calculation) */
  private lastDownloadedBytes: number = 0;
  /** Total number of fragments downloaded */
  private fragmentCount: number = 0;
  /** AbortSignal for real-time cancellation */
  private abortSignal?: AbortSignal;

  /**
   * Create a new M3U8 download handler
   * @param options - Configuration options
   */
  constructor(options: M3u8DownloadHandlerOptions = {}) {
    this.onProgress = options.onProgress;
    this.maxConcurrent = options.maxConcurrent || 3;
    this.ffmpegTimeout = options.ffmpegTimeout || 900000; // Default 15 minutes
  }

  /**
   * Reset all download-specific state to initial values
   * Called at the start of each download to prevent state pollution from previous downloads
   * @param stateId - The download state ID for this download
   * @param abortSignal - Optional abort signal for cancellation
   * @private
   */
  private resetDownloadState(stateId: string, abortSignal?: AbortSignal): void {
    this.downloadId = stateId;
    this.bytesDownloaded = 0;
    this.totalBytes = 0;
    this.lastUpdateTime = 0;
    this.lastDownloadedBytes = 0;
    this.fragmentCount = 0;
    this.abortSignal = abortSignal;
  }

  /**
   * Update download progress with bytes and speed calculation
   * @private
   */
  private async updateProgress(
    stateId: string,
    downloadedBytes: number,
    totalBytes: number,
    message?: string,
  ): Promise<void> {
    throwIfAborted(this.abortSignal);

    const state = await getDownload(stateId);
    if (!state) {
      return;
    }

    const now = Date.now();
    let speed = 0;

    // Calculate speed if we have previous data
    if (this.lastUpdateTime > 0 && this.lastDownloadedBytes > 0) {
      const timeDelta = (now - this.lastUpdateTime) / 1000; // Convert to seconds
      const bytesDelta = downloadedBytes - this.lastDownloadedBytes;

      if (timeDelta > 0) {
        speed = bytesDelta / timeDelta; // bytes per second
      }
    }

    // Update tracking variables
    this.lastUpdateTime = now;
    this.lastDownloadedBytes = downloadedBytes;
    this.bytesDownloaded = downloadedBytes;
    this.totalBytes = totalBytes;

    const percentage =
      totalBytes > 0 ? (downloadedBytes / totalBytes) * 100 : 0;
    state.progress.downloaded = downloadedBytes;
    state.progress.total = totalBytes;
    state.progress.percentage = percentage;
    state.progress.stage = DownloadStage.DOWNLOADING;
    state.progress.message =
      message ||
      `Downloaded ${this.formatFileSize(downloadedBytes)}/${this.formatFileSize(
        totalBytes,
      )}`;
    state.progress.speed = speed;
    state.progress.lastUpdateTime = now;
    state.progress.lastDownloaded = downloadedBytes;

    await storeDownload(state);
    this.notifyProgress(state);
  }

  /**
   * Format file size helper (B, KB, MB, GB)
   * @private
   */
  private formatFileSize(bytes: number): string {
    if (bytes < 1024) {
      return `${bytes.toFixed(0)} B`;
    } else if (bytes < 1024 * 1024) {
      return `${(bytes / 1024).toFixed(1)} KB`;
    } else if (bytes < 1024 * 1024 * 1024) {
      return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    } else {
      return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
    }
  }

  /**
   * Download a single fragment
   * @private
   */
  private async downloadFragment(
    fragment: Fragment,
    downloadId: string,
    fetchAttempts: number = 3,
  ): Promise<number> {
    if (!this.abortSignal) {
      throw new Error("AbortSignal is required for fragment download");
    }
    
    const data = await cancelIfAborted(
      fetchArrayBuffer(fragment.uri, fetchAttempts, this.abortSignal),
      this.abortSignal
    );

    const decryptedData = await cancelIfAborted(
      decryptFragment(
        fragment.key,
        data,
        fetchAttempts,
        this.abortSignal,
      ),
      this.abortSignal
    );

    // Store in IndexedDB
    await storeChunk(downloadId, fragment.index, decryptedData);

    // Return the size of the downloaded fragment
    return decryptedData.byteLength;
  }

  /**
   * Download all fragments with concurrency control
   * @private
   */
  private async downloadAllFragments(
    fragments: Fragment[],
    downloadId: string,
    stateId: string,
  ): Promise<void> {
    const totalFragments = fragments.length;
    let downloadedFragments = 0;
    let sessionBytesDownloaded = 0;
    const errors: Error[] = [];

    // Initialize progress tracking
    if (this.lastUpdateTime === 0) {
      this.lastUpdateTime = Date.now();
      this.lastDownloadedBytes = 0;
    }

    let estimatedTotalBytes = 0;
    if (fragments.length > 0 && fragments[0] && this.abortSignal) {
      throwIfAborted(this.abortSignal);
      
      try {
        const firstFragmentSize = await cancelIfAborted(
          this.downloadFragment(fragments[0], downloadId),
          this.abortSignal
        );
        
        sessionBytesDownloaded += firstFragmentSize;
        downloadedFragments++;
        this.bytesDownloaded += firstFragmentSize;

        // Estimate total based on first fragment size
        estimatedTotalBytes = firstFragmentSize * totalFragments;
        this.totalBytes = Math.max(this.totalBytes, estimatedTotalBytes);

        await cancelIfAborted(
          this.updateProgress(
            stateId,
            this.bytesDownloaded,
            this.totalBytes,
            `Downloading fragments...`,
          ),
          this.abortSignal
        );
      } catch (error) {
        logger.error(
          `Failed to download first fragment for size estimation:`,
          error,
        );
        estimatedTotalBytes = 0;
      }
    }

    // Download remaining fragments with concurrency limit
    const downloadQueue: Promise<void>[] = [];
    let currentIndex = 1; // Start from index 1 since we already downloaded the first

    const downloadNext = async (): Promise<void> => {
      if (!this.abortSignal) {
        throw new Error("AbortSignal is required for fragment downloads");
      }

      while (currentIndex < totalFragments) {
        throwIfAborted(this.abortSignal);

        const fragmentIndex = currentIndex++;
        const fragment = fragments[fragmentIndex];

        if (!fragment) {
          logger.warn(`Fragment at index ${fragmentIndex} is undefined, skipping`);
          continue;
        }

        try {
          const fragmentSize = await cancelIfAborted(
            this.downloadFragment(fragment, downloadId),
            this.abortSignal
          );

          sessionBytesDownloaded += fragmentSize;
          downloadedFragments++;
          this.bytesDownloaded += fragmentSize;

          if (estimatedTotalBytes === 0 || downloadedFragments > 0) {
            const averageFragmentSize =
              sessionBytesDownloaded / downloadedFragments;
            const sessionEstimatedTotal = averageFragmentSize * totalFragments;
            estimatedTotalBytes = sessionEstimatedTotal;
            this.totalBytes = Math.max(this.totalBytes, estimatedTotalBytes);
          }

          await cancelIfAborted(
            this.updateProgress(
              stateId,
              this.bytesDownloaded,
              this.totalBytes,
              `Downloading fragments...`,
            ),
            this.abortSignal
          );
        } catch (error) {
          // If cancellation error, propagate it immediately
          if (error instanceof CancellationError) {
            throw error;
          }
          
          const err = error instanceof Error ? error : new Error(String(error));
          errors.push(err);
          logger.error(`Fragment ${fragment?.index ?? fragmentIndex} failed:`, err);
          // Continue with other fragments even if one fails (unless cancelled)
        }
      }
    };

    // Start concurrent downloads
    for (
      let i = 0;
      i < Math.min(this.maxConcurrent, totalFragments - downloadedFragments);
      i++
    ) {
      downloadQueue.push(downloadNext());
    }

    // Wait for all downloads to complete
    // Use Promise.allSettled to handle cancellation errors properly
    const results = await Promise.allSettled(downloadQueue);
    
    // Check if any download was cancelled
    const cancelledError = results.find(
      (result) =>
        result.status === "rejected" &&
        result.reason instanceof CancellationError
    );
    
    if (cancelledError) {
      throw new CancellationError();
    }

    throwIfAborted(this.abortSignal);

    this.totalBytes = Math.max(this.totalBytes, this.bytesDownloaded);
    if (this.abortSignal) {
      await cancelIfAborted(
        this.updateProgress(
          stateId,
          this.bytesDownloaded,
          this.totalBytes,
          `Downloaded ${downloadedFragments}/${totalFragments} fragments`,
        ),
        this.abortSignal
      );
    } else {
      await this.updateProgress(
        stateId,
        this.bytesDownloaded,
        this.totalBytes,
        `Downloaded ${downloadedFragments}/${totalFragments} fragments`,
      );
    }

    // If there were errors, throw an error (but we still have some fragments)
    if (errors.length > 0 && downloadedFragments === 0) {
      throw new Error(`Failed to download any fragments: ${errors[0].message}`);
    }

    if (downloadedFragments < totalFragments) {
      logger.warn(
        `Downloaded ${downloadedFragments}/${totalFragments} fragments. Some fragments failed.`,
      );
    }
  }

  /**
   * Process chunks using offscreen document and FFmpeg (5-minute timeout)
   * @private
   */
  private async streamToMp4Blob(
    fileName: string,
    stateId: string,
    onProgress?: (progress: number, message: string) => void,
  ): Promise<string> {
    // Ensure offscreen document exists
    await createOffscreenDocument();

    // Send processing request to offscreen document
    return new Promise<string>((resolve, reject) => {
      // Check if already aborted before setting up listeners and timeouts
      if (this.abortSignal?.aborted) {
        reject(new CancellationError());
        return;
      }

      let timeoutId: ReturnType<typeof setTimeout> | null = null;
      let isSettled = false;

      // Cleanup function to remove all listeners and clear timeout
      const cleanup = () => {
        if (timeoutId) {
          clearTimeout(timeoutId);
          timeoutId = null;
        }
        chrome.runtime.onMessage.removeListener(messageListener);
        if (this.abortSignal) {
          this.abortSignal.removeEventListener("abort", abortHandler);
        }
      };

      // Abort handler as named function for cleanup
      const abortHandler = () => {
        if (isSettled) return;
        isSettled = true;
        cleanup();
        reject(new CancellationError());
      };
      
      // Set up message listener for offscreen responses
      const messageListener = (message: any) => {
        if (
          message.type === MessageType.OFFSCREEN_PROCESS_M3U8_RESPONSE &&
          message.payload?.downloadId === this.downloadId
        ) {
          const {
            type,
            blobUrl,
            error,
            progress,
            message: progressMessage,
          } = message.payload;

          if (type === "success") {
            if (isSettled) return;
            isSettled = true;
            cleanup();
            resolve(blobUrl);
          } else if (type === "error") {
            if (isSettled) return;
            isSettled = true;
            cleanup();
            reject(new Error(error || "FFmpeg processing failed"));
          } else if (type === "progress") {
            // Forward progress updates
            onProgress?.(progress, progressMessage || "");
          }
        }
      };

      chrome.runtime.onMessage.addListener(messageListener);

      // Add abort listener
      if (this.abortSignal) {
        this.abortSignal.addEventListener("abort", abortHandler);
      }

      // Send processing request for M3U8 media playlist
      chrome.runtime.sendMessage(
        {
          type: MessageType.OFFSCREEN_PROCESS_M3U8,
          payload: {
            downloadId: this.downloadId,
            fragmentCount: this.fragmentCount,
            filename: fileName,
          },
        },
        (response) => {
          // Check for errors to prevent "unchecked runtime.lastError" warning
          if (chrome.runtime.lastError) {
            if (isSettled) return;
            isSettled = true;
            cleanup();
            reject(
              new Error(
                `Failed to send processing request: ${chrome.runtime.lastError.message}`,
              ),
            );
            return;
          }
          // Response is handled by messageListener
        },
      );

      // Set timeout to prevent hanging (configurable via settings)
      timeoutId = setTimeout(() => {
        if (isSettled) return;
        isSettled = true;
        // Check if download was cancelled before rejecting with timeout
        if (this.abortSignal?.aborted) {
          cleanup();
          reject(new CancellationError());
          return;
        }
        cleanup();
        reject(new Error("FFmpeg processing timeout"));
      }, this.ffmpegTimeout);
    });
  }

  /**
   * Save blob URL to file using Chrome downloads API
   * Stores chromeDownloadId in download state for reliable cancellation
   * @private
   */
  private async saveBlobUrlToFile(
    blobUrl: string,
    filename: string,
    stateId: string,
  ): Promise<string> {
    try {
      // Use Chrome downloads API to save the file
      return new Promise<string>((resolve, reject) => {
        chrome.downloads.download(
          {
            url: blobUrl,
            filename,
            saveAs: false,
          },
          async (downloadId) => {
            if (chrome.runtime.lastError) {
              reject(new Error(chrome.runtime.lastError.message));
              return;
            }

            // Store chromeDownloadId in download state immediately
            const currentState = await getDownload(stateId);
            if (currentState) {
              currentState.chromeDownloadId = downloadId!;
              await storeDownload(currentState);
            }

            // Wait for download to complete
            const checkComplete = () => {
              chrome.downloads.search({ id: downloadId }, (results) => {
                if (chrome.runtime.lastError) {
                  reject(new Error(chrome.runtime.lastError.message));
                  return;
                }

                const item = results?.[0];
                if (!item) {
                  reject(new Error("Download item not found"));
                  return;
                }

                if (item.state === "complete") {
                  // Clean up blob URL after successful download
                  if (typeof URL !== "undefined" && URL.revokeObjectURL) {
                    URL.revokeObjectURL(blobUrl);
                  }
                  resolve(item.filename);
                } else if (item.state === "interrupted") {
                  if (typeof URL !== "undefined" && URL.revokeObjectURL) {
                    URL.revokeObjectURL(blobUrl);
                  }
                  reject(new Error(item.error || "Download interrupted"));
                } else {
                  // Check again in a bit
                  setTimeout(checkComplete, 100);
                }
              });
            };

            checkComplete();
          },
        );
      });
    } catch (error) {
      // Clean up blob URL on error
      if (typeof URL !== "undefined" && URL.revokeObjectURL) {
        URL.revokeObjectURL(blobUrl);
      }
      throw error;
    }
  }

  /**
   * Download M3U8 media playlist video
   * @param mediaPlaylistUrl - URL of M3U8 media playlist
   * @param filename - Target filename
   * @param stateId - Download state ID for progress tracking
   * @returns Promise resolving to file path and extension
   * @throws {DownloadError} If download fails
   */
  async download(
    mediaPlaylistUrl: string,
    filename: string,
    stateId: string,
    abortSignal?: AbortSignal,
  ): Promise<{ filePath: string; fileExtension?: string }> {
    // Reset all download-specific state to prevent pollution from previous downloads
    this.resetDownloadState(stateId, abortSignal);
    
    try {
      logger.info(
        `Starting M3U8 media playlist download from ${mediaPlaylistUrl}`,
      );

      // Update progress: parsing playlist
      await this.updateProgress(stateId, 0, 0, "Parsing playlist...");

      // Fetch and parse media playlist
      const mediaPlaylistText = this.abortSignal
        ? await cancelIfAborted(
            fetchText(mediaPlaylistUrl, 3, this.abortSignal),
            this.abortSignal
          )
        : await fetchText(mediaPlaylistUrl, 3);

      // Check for DRM protection
      if (hasDrm(mediaPlaylistText)) {
        throw new DownloadError("Cannot download DRM-protected content");
      }

      const fragments = parseLevelsPlaylist(
        mediaPlaylistText,
        mediaPlaylistUrl,
      );

      if (fragments.length === 0) {
        throw new Error("No fragments found in media playlist");
      }

      logger.info(`Found ${fragments.length} fragments`);

      // Check if cancelled before starting fragment downloads
      throwIfAborted(this.abortSignal);

      // Download all fragments
      await this.downloadAllFragments(fragments, this.downloadId, stateId);

      this.fragmentCount = fragments.length;

      throwIfAborted(this.abortSignal);

      // Update progress: merging with FFmpeg
      const mergingState = await getDownload(stateId);
      if (mergingState) {
        mergingState.progress.stage = DownloadStage.MERGING;
        mergingState.progress.message = "Merging streams...";
        await storeDownload(mergingState);
        this.notifyProgress(mergingState);
      }

      // Sanitize and extract base filename without extension
      const sanitizedFilename = sanitizeFilename(filename);
      let baseFileName = sanitizedFilename.replace(/\.[^/.]+$/, "");
      
      // Fallback if base filename is empty or invalid
      if (!baseFileName || baseFileName.trim() === "") {
        const timestamp = Date.now();
        baseFileName = `video_${timestamp}`;
        logger.warn(`Filename became empty after sanitization, using fallback: ${baseFileName}`);
      }

      // Process chunks using offscreen document and FFmpeg
      const blobUrl = await this.streamToMp4Blob(
        baseFileName,
        stateId,
        async (progress, message) => {
          // Update progress during FFmpeg processing
          // Progress is 0-1, show it as 0-100% for merging phase (restart progress bar)
          const state = await getDownload(stateId);
          if (state) {
            // Show merging progress as 0-100% (restart progress bar for merging phase)
            state.progress.percentage = progress * 100;
            state.progress.message = message;
            state.progress.stage = DownloadStage.MERGING;
            await storeDownload(state);
            this.notifyProgress(state);
          }
        },
      );

      // Update progress: saving
      const savingState = await getDownload(stateId);
      if (savingState) {
        savingState.progress.stage = DownloadStage.SAVING;
        savingState.progress.message = "Saving file...";
        savingState.progress.percentage = 95;
        await storeDownload(savingState);
        this.notifyProgress(savingState);
      }

      // Save to file using blob URL
      const filePath = await this.saveBlobUrlToFile(
        blobUrl,
        `${baseFileName}.mp4`,
        stateId,
      );

      // Update progress: completed
      const finalState = await getDownload(stateId);
      if (finalState) {
        finalState.localPath = filePath;
        finalState.progress.stage = DownloadStage.COMPLETED;
        finalState.progress.message = "Download completed";
        finalState.progress.percentage = 100;
        finalState.progress.downloaded =
          finalState.progress.total || this.bytesDownloaded || 0;
        finalState.updatedAt = Date.now();
        await storeDownload(finalState);
        this.notifyProgress(finalState);

        // Verify state is persisted
        const verifyState = await getDownload(stateId);
        if (verifyState && verifyState.progress.stage !== DownloadStage.COMPLETED) {
          logger.warn(`State verification failed for ${stateId}, retrying...`);
          verifyState.progress.stage = DownloadStage.COMPLETED;
          verifyState.progress.message = "Download completed";
          verifyState.progress.percentage = 100;
          await storeDownload(verifyState);
          this.notifyProgress(verifyState);
        }
      } else {
        logger.error(
          `Could not find download state ${stateId} to mark as completed`,
        );
      }

      logger.info(`M3U8 media playlist download completed: ${filePath}`);

      return {
        filePath,
        fileExtension: "mp4",
      };
    } catch (error) {
      logger.error("M3U8 media playlist download failed:", error);
      // Re-throw the original error (preserve CancellationError, DownloadError, etc.)
      throw error;
    } finally {
      // Always clean up IndexedDB chunks regardless of success/failure/cancellation
      try {
        await deleteChunks(this.downloadId || stateId);
        logger.info(`Cleaned up chunks for M3U8 download ${this.downloadId || stateId}`);
      } catch (cleanupError) {
        logger.error("Failed to clean up chunks:", cleanupError);
        // Don't throw - cleanup errors shouldn't mask original errors
      }
    }
  }

  /**
   * Notify progress callback if configured
   * @private
   */
  private notifyProgress(state: DownloadState): void {
    if (this.onProgress) {
      this.onProgress(state);
    }
  }
}
