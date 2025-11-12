/**
 * Direct video URL downloader using Chrome downloads API
 */

import { DownloadError } from "../../utils/errors";
import { logger } from "../../utils/logger";
import {
  DirectDownloadProgressCallback,
  DirectDownloadOptions,
  DirectDownloadResult,
} from "../types";

export class DirectDownloader {
  private readonly onProgress?: DirectDownloadProgressCallback;
  private downloadProgressListeners: Map<
    number,
    {
      resolve: (result: DirectDownloadResult) => void;
      reject: (error: Error) => void;
      filename: string;
    }
  > = new Map();

  constructor(options: DirectDownloadOptions = {}) {
    this.onProgress = options.onProgress;
    this.setupDownloadProgressTracking();
  }

  /**
   * Set up Chrome downloads progress tracking
   */
  private setupDownloadProgressTracking(): void {
    chrome.downloads.onChanged.addListener((downloadDelta) => {
      const chromeDownloadId = downloadDelta.id;
      const listener = this.downloadProgressListeners.get(chromeDownloadId);

      if (!listener) {
        return; // Not one of our tracked downloads
      }

      // Update progress on any change (bytesReceived, state, etc.)
      this.updateProgressFromChromeDownload(
        chromeDownloadId,
        listener,
        downloadDelta,
      ).catch((error) => {
        logger.error(
          `Error updating progress for download ${chromeDownloadId}:`,
          error,
        );
      });
    });
  }

  /**
   * Update progress from Chrome download state
   */
  private async updateProgressFromChromeDownload(
    chromeDownloadId: number,
    listener: {
      resolve: (result: DirectDownloadResult) => void;
      reject: (error: Error) => void;
      filename: string;
    },
    delta: chrome.downloads.DownloadDelta,
  ): Promise<void> {
    // Get current download item
    const downloadItem =
      await new Promise<chrome.downloads.DownloadItem | null>((resolve) => {
        chrome.downloads.search({ id: chromeDownloadId }, (results) => {
          if (chrome.runtime.lastError || !results || results.length === 0) {
            resolve(null);
          } else {
            resolve(results[0]);
          }
        });
      });

    if (!downloadItem) {
      return;
    }

    // Report progress if callback is provided
    if (this.onProgress && downloadItem.bytesReceived !== undefined) {
      const loaded = downloadItem.bytesReceived;
      const total = downloadItem.totalBytes || 0;
      const percentage = total > 0 ? (loaded / total) * 100 : 0;
      this.onProgress(loaded, total, percentage);
    }

    // Handle completion or failure
    if (delta.state) {
      if (delta.state.current === "complete") {
        const result: DirectDownloadResult = {
          filePath: downloadItem.filename,
          totalBytes: downloadItem.totalBytes,
        };
        this.downloadProgressListeners.delete(chromeDownloadId);
        listener.resolve(result);
      } else if (delta.state.current === "interrupted") {
        this.downloadProgressListeners.delete(chromeDownloadId);
        listener.reject(
          new Error(downloadItem.error || "Download interrupted"),
        );
      }
    }
  }

  /**
   * Download video from direct URL using Chrome downloads API
   * Returns the file path where the video was saved
   */
  async download(url: string, filename: string): Promise<DirectDownloadResult> {
    try {
      logger.info(`Downloading direct video from ${url} to ${filename}`);

      // Use Chrome downloads API with direct URL (most efficient - no blob download)
      const chromeDownloadId = await new Promise<number>((resolve, reject) => {
        chrome.downloads.download(
          {
            url,
            filename,
            saveAs: false,
          },
          (id) => {
            if (chrome.runtime.lastError) {
              reject(new Error(chrome.runtime.lastError.message));
            } else {
              resolve(id!);
            }
          },
        );
      });

      // Wait for download to complete
      const result = await new Promise<DirectDownloadResult>(
        (resolve, reject) => {
          // Store promise resolvers for onChanged callback to use
          this.downloadProgressListeners.set(chromeDownloadId, {
            resolve,
            reject,
            filename,
          });

          // Set timeout as fallback in case onChanged doesn't fire
          setTimeout(() => {
            if (this.downloadProgressListeners.has(chromeDownloadId)) {
              this.downloadProgressListeners.delete(chromeDownloadId);
              reject(
                new Error("Download timeout - completion event not received"),
              );
            }
          }, 300000); // 5 minute timeout
        },
      );

      logger.info(`Successfully downloaded to ${result.filePath}`);

      return result;
    } catch (error) {
      logger.error("Direct download failed:", error);
      throw error instanceof DownloadError
        ? error
        : new DownloadError(`Direct download failed: ${error}`);
    }
  }
}
