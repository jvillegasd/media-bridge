/**
 * Direct download handler - orchestrates direct video downloads using Chrome downloads API
 *
 * This handler is responsible for downloading videos that are available as direct file URLs
 * (e.g., .mp4, .webm, .mov files). It uses the Chrome downloads API to handle the actual
 * download process, which provides native download progress tracking and file management.
 *
 * Key features:
 * - Uses Chrome downloads API for native download handling
 * - Tracks download progress via Chrome's download events
 * - Extracts file extensions from URL or HTTP headers
 * - Handles download completion, interruption, and error states
 * - Updates download state with progress information
 *
 * @module DirectDownloadHandler
 */

import { DownloadError } from "../../utils/errors";
import { getDownload, storeDownload } from "../../database/downloads";
import { DownloadState } from "../../types";
import { logger } from "../../utils/logger";
import {
  detectExtensionFromUrl,
  detectExtensionFromContentType,
} from "../../metadata/metadata-extractor";
import {
  DownloadProgressCallback,
  DirectDownloadHandlerOptions,
  DirectDownloadHandlerResult,
  DirectDownloadResult,
} from "../types";

/** Internal listener structure for tracking Chrome download progress */
interface DownloadListener {
  resolve: (result: DirectDownloadResult) => void;
  reject: (error: Error) => void;
  stateId: string;
  handler: DirectDownloadHandler; // Store instance reference
}

/**
 * Direct download handler using Chrome downloads API
 * Simplest download method - no fragments, decryption, or merging required
 */
export class DirectDownloadHandler {
  private readonly onProgress?: DownloadProgressCallback;
  private static downloadProgressListeners: Map<number, DownloadListener> =
    new Map();
  private static listenerSetup = false;

  constructor(options: DirectDownloadHandlerOptions = {}) {
    this.onProgress = options.onProgress;
    this.setupDownloadProgressTracking();
  }

  /**
   * Set up Chrome downloads progress tracking (static, only once)
   * @private
   */
  private setupDownloadProgressTracking(): void {
    if (DirectDownloadHandler.listenerSetup) {
      return; // Already set up
    }

    DirectDownloadHandler.listenerSetup = true;
    chrome.downloads.onChanged.addListener((downloadDelta) => {
      const chromeDownloadId = downloadDelta.id;
      const listener =
        DirectDownloadHandler.downloadProgressListeners.get(chromeDownloadId);

      if (!listener) {
        return; // Not one of our tracked downloads
      }

      // Call instance method through stored handler reference
      listener.handler
        .handleDownloadChange(chromeDownloadId, listener, downloadDelta)
        .catch((error) => {
          logger.error(
            `Error handling download change for ${chromeDownloadId}:`,
            error,
          );
        });
    });
  }

  /**
   * Handle download change event from Chrome
   * @private
   */
  private async handleDownloadChange(
    chromeDownloadId: number,
    listener: DownloadListener,
    delta: chrome.downloads.DownloadDelta,
  ): Promise<void> {
    const downloadItem = await this.getDownloadItem(chromeDownloadId);

    if (!downloadItem) {
      return;
    }

    // Update progress if download item has progress info and state ID
    if (listener.stateId && downloadItem.bytesReceived !== undefined) {
      logger.debug(`Updating download state progress for ${listener.stateId}`);
      await this.updateDownloadStateProgress(listener.stateId, downloadItem);
    }

    // Handle completion or failure
    if (delta.state) {
      if (delta.state.current === "complete") {
        this.handleDownloadCompletion(chromeDownloadId, downloadItem, listener);
      } else if (delta.state.current === "interrupted") {
        this.handleDownloadFailure(chromeDownloadId, downloadItem, listener);
      }
    }
  }

  /**
   * Get Chrome download item by ID
   * @private
   */
  private async getDownloadItem(
    chromeDownloadId: number,
  ): Promise<chrome.downloads.DownloadItem | null> {
    return new Promise<chrome.downloads.DownloadItem | null>((resolve) => {
      chrome.downloads.search({ id: chromeDownloadId }, (results) => {
        if (chrome.runtime.lastError || !results || results.length === 0) {
          resolve(null);
        } else {
          resolve(results[0]);
        }
      });
    });
  }

  /**
   * Update download state with progress information
   * @private
   */
  private async updateDownloadStateProgress(
    stateId: string,
    downloadItem: chrome.downloads.DownloadItem,
  ): Promise<void> {
    if (downloadItem.bytesReceived === undefined) {
      return;
    }

    const currentState = await getDownload(stateId);
    if (!currentState) {
      return;
    }

    const loaded = downloadItem.bytesReceived;
    const total = downloadItem.totalBytes || 0;
    const percentage = total > 0 ? (loaded / total) * 100 : 0;

    currentState.progress.downloaded = loaded;
    currentState.progress.total = total;
    currentState.progress.percentage = percentage;
    currentState.progress.stage = "downloading";
    currentState.progress.message = "Downloading...";

    await storeDownload(currentState);
    this.notifyProgress(currentState);
  }

  /**
   * Handle download completion
   * @private
   */
  private handleDownloadCompletion(
    chromeDownloadId: number,
    downloadItem: chrome.downloads.DownloadItem,
    listener: DownloadListener,
  ): void {
    const result: DirectDownloadResult = {
      filePath: downloadItem.filename,
      totalBytes: downloadItem.totalBytes,
    };

    DirectDownloadHandler.downloadProgressListeners.delete(chromeDownloadId);
    listener.resolve(result);
  }

  /**
   * Handle download failure
   * @private
   */
  private handleDownloadFailure(
    chromeDownloadId: number,
    downloadItem: chrome.downloads.DownloadItem,
    listener: DownloadListener,
  ): void {
    DirectDownloadHandler.downloadProgressListeners.delete(chromeDownloadId);
    listener.reject(new Error(downloadItem.error || "Download interrupted"));
  }

  /**
   * Extract file extension from URL or HTTP headers
   * @private
   */
  private async extractFileExtension(url: string): Promise<string | undefined> {
    // Try to get extension from HTTP headers first
    try {
      const response = await fetch(url, { method: "HEAD" });
      const contentType = response.headers.get("content-type") || "";
      const extension =
        detectExtensionFromUrl(url) ||
        detectExtensionFromContentType(contentType);

      if (extension) {
        return extension;
      }
    } catch (error) {
      logger.warn(`Failed to get headers for ${url}:`, error);
    }

    // Fallback to URL-based detection
    return detectExtensionFromUrl(url);
  }

  /**
   * Start Chrome download and return download ID
   * @private
   */
  private async startChromeDownload(
    url: string,
    filename: string,
  ): Promise<number> {
    return new Promise<number>((resolve, reject) => {
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
  }

  /**
   * Wait for download to complete (5-minute timeout)
   * @private
   */
  private async waitForDownloadCompletion(
    chromeDownloadId: number,
    stateId: string,
  ): Promise<DirectDownloadResult> {
    return new Promise<DirectDownloadResult>((resolve, reject) => {
      // Store promise resolvers and instance reference for onChanged callback
      DirectDownloadHandler.downloadProgressListeners.set(chromeDownloadId, {
        resolve,
        reject,
        stateId,
        handler: this, // Store instance reference
      });

      // Set timeout as fallback in case onChanged doesn't fire
      setTimeout(() => {
        if (
          DirectDownloadHandler.downloadProgressListeners.has(chromeDownloadId)
        ) {
          DirectDownloadHandler.downloadProgressListeners.delete(
            chromeDownloadId,
          );
          reject(new Error("Download timeout - completion event not received"));
        }
      }, 300000); // 5 minute timeout
    });
  }

  /**
   * Mark download state as completed
   * @private
   */
  private async markDownloadAsCompleted(
    stateId: string,
    result: DirectDownloadResult,
    fileExtension?: string,
  ): Promise<void> {
    const currentState = await getDownload(stateId);
    if (!currentState) {
      return;
    }

    if (fileExtension) {
      currentState.metadata = {
        ...currentState.metadata,
        fileExtension,
      };
    }

    currentState.localPath = result.filePath;
    currentState.progress.stage = "completed";
    currentState.progress.message = "Download completed";
    currentState.progress.percentage = 100;

    if (result.totalBytes) {
      currentState.progress.total = result.totalBytes;
      currentState.progress.downloaded = result.totalBytes;
    }

    currentState.updatedAt = Date.now();
    await storeDownload(currentState);
    this.notifyProgress(currentState);
  }

  /**
   * Download direct video using Chrome downloads API
   * @param url - Direct video URL
   * @param filename - Target filename
   * @param stateId - Download state ID for progress tracking
   * @returns Promise resolving to file path and extension
   * @throws {DownloadError} If download fails
   */
  async download(
    url: string,
    filename: string,
    stateId: string,
  ): Promise<DirectDownloadHandlerResult> {
    try {
      logger.info(`Downloading direct video from ${url} to ${filename}`);

      // Extract file extension from URL or headers
      const fileExtension = await this.extractFileExtension(url);

      // Start Chrome download
      const chromeDownloadId = await this.startChromeDownload(url, filename);

      // Wait for download to complete
      const result = await this.waitForDownloadCompletion(
        chromeDownloadId,
        stateId,
      );

      logger.info(`Successfully downloaded to ${result.filePath}`);

      // Mark download as completed in state
      await this.markDownloadAsCompleted(stateId, result, fileExtension);

      return {
        filePath: result.filePath,
        fileExtension,
      };
    } catch (error) {
      logger.error("Direct download failed:", error);
      throw error instanceof DownloadError
        ? error
        : new DownloadError(`Direct download failed: ${error}`);
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
