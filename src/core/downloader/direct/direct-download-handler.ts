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
import { DownloadStateManager } from "../../storage/download-state";
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

/**
 * Internal listener structure for tracking Chrome download progress
 * 
 * @interface DownloadListener
 * @property {Function} resolve - Promise resolver for download completion
 * @property {Function} reject - Promise rejecter for download failure
 * @property {string} stateId - Download state ID for progress tracking
 * @property {DirectDownloadHandler} handler - Reference to handler instance
 */
interface DownloadListener {
  resolve: (result: DirectDownloadResult) => void;
  reject: (error: Error) => void;
  stateId: string;
  handler: DirectDownloadHandler; // Store instance reference
}

/**
 * Direct download handler class
 * 
 * Handles direct video file downloads using Chrome's downloads API. This is the simplest
 * download method as it doesn't require fragment downloading, decryption, or merging.
 * 
 * @class DirectDownloadHandler
 * @example
 * ```typescript
 * const handler = new DirectDownloadHandler({
 *   onProgress: (state) => console.log(`Progress: ${state.progress.percentage}%`)
 * });
 * 
 * const result = await handler.download(
 *   'https://example.com/video.mp4',
 *   'video.mp4',
 *   'state-id-123'
 * );
 * ```
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
   * 
   * Initializes a global listener for Chrome download events. This is set up once
   * per extension lifecycle and tracks all downloads initiated by this handler.
   * 
   * The listener monitors download state changes and updates the corresponding
   * download state with progress information.
   * 
   * @private
   * @static
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
   * 
   * Processes download state changes from Chrome's download API. Updates progress
   * information and handles completion or failure events.
   * 
   * @private
   * @param {number} chromeDownloadId - Chrome's internal download ID
   * @param {DownloadListener} listener - Download listener with promise resolvers
   * @param {chrome.downloads.DownloadDelta} delta - Download state change delta
   * @returns {Promise<void>}
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
   * 
   * Retrieves the current state of a Chrome download by its ID.
   * 
   * @private
   * @param {number} chromeDownloadId - Chrome's internal download ID
   * @returns {Promise<chrome.downloads.DownloadItem | null>} Download item or null if not found
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
   * 
   * Updates the download state with current progress (bytes downloaded, percentage, etc.)
   * and notifies the progress callback if provided.
   * 
   * @private
   * @param {string} stateId - Download state ID
   * @param {chrome.downloads.DownloadItem} downloadItem - Chrome download item with progress info
   * @returns {Promise<void>}
   */
  private async updateDownloadStateProgress(
    stateId: string,
    downloadItem: chrome.downloads.DownloadItem,
  ): Promise<void> {
    if (downloadItem.bytesReceived === undefined) {
      return;
    }

    const currentState = await DownloadStateManager.getDownload(stateId);
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

    await DownloadStateManager.saveDownload(currentState);
    this.notifyProgress(currentState);
  }

  /**
   * Handle download completion
   * 
   * Processes successful download completion, resolves the download promise,
   * and cleans up the download listener.
   * 
   * @private
   * @param {number} chromeDownloadId - Chrome's internal download ID
   * @param {chrome.downloads.DownloadItem} downloadItem - Completed download item
   * @param {DownloadListener} listener - Download listener with promise resolvers
   * @returns {void}
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
   * 
   * Processes download interruption or failure, rejects the download promise,
   * and cleans up the download listener.
   * 
   * @private
   * @param {number} chromeDownloadId - Chrome's internal download ID
   * @param {chrome.downloads.DownloadItem} downloadItem - Failed download item
   * @param {DownloadListener} listener - Download listener with promise resolvers
   * @returns {void}
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
   * 
   * Attempts to detect the file extension by:
   * 1. Checking the URL path for a file extension
   * 2. Checking the Content-Type HTTP header
   * 
   * Falls back to URL-based detection if HTTP header check fails.
   * 
   * @private
   * @param {string} url - Video URL
   * @returns {Promise<string | undefined>} Detected file extension or undefined
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
   * 
   * Initiates a download using Chrome's downloads API. The download is started
   * without prompting the user (saveAs: false).
   * 
   * @private
   * @param {string} url - Video URL to download
   * @param {string} filename - Target filename
   * @returns {Promise<number>} Chrome download ID
   * @throws {Error} If download initiation fails
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
   * Wait for download to complete
   * 
   * Sets up a promise that resolves when the download completes or rejects on failure.
   * Uses Chrome's download events to track progress and completion.
   * 
   * Includes a 5-minute timeout as a fallback in case the completion event doesn't fire.
   * 
   * @private
   * @param {number} chromeDownloadId - Chrome's internal download ID
   * @param {string} stateId - Download state ID for progress tracking
   * @returns {Promise<DirectDownloadResult>} Download result with file path and size
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
   * 
   * Updates the download state to mark it as completed, including file path,
   * final progress, and file extension if detected.
   * 
   * @private
   * @param {string} stateId - Download state ID
   * @param {DirectDownloadResult} result - Download result with file path and size
   * @param {string} [fileExtension] - Optional file extension to store in metadata
   * @returns {Promise<void>}
   */
  private async markDownloadAsCompleted(
    stateId: string,
    result: DirectDownloadResult,
    fileExtension?: string,
  ): Promise<void> {
    const currentState = await DownloadStateManager.getDownload(stateId);
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
    await DownloadStateManager.saveDownload(currentState);
    this.notifyProgress(currentState);
  }

  /**
   * Download direct video using Chrome downloads API and return file path with extracted metadata
   * 
   * Main entry point for downloading a direct video file. This method:
   * 1. Extracts file extension from URL or HTTP headers
   * 2. Initiates Chrome download
   * 3. Waits for download completion
   * 4. Updates download state
   * 5. Returns file path and extension
   * 
   * @public
   * @param {string} url - Direct video URL (e.g., https://example.com/video.mp4)
   * @param {string} filename - Target filename for the downloaded file
   * @param {string} stateId - Download state ID for progress tracking
   * @returns {Promise<DirectDownloadHandlerResult>} Result containing file path and extension
   * @throws {DownloadError} If download fails at any stage
   * 
   * @example
   * ```typescript
   * const result = await handler.download(
   *   'https://example.com/video.mp4',
   *   'my-video.mp4',
   *   'download-state-123'
   * );
   * console.log(`Downloaded to: ${result.filePath}`);
   * ```
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
   * Notify progress callback
   * 
   * Invokes the progress callback if one was provided during handler construction.
   * 
   * @private
   * @param {DownloadState} state - Current download state
   * @returns {void}
   */
  private notifyProgress(state: DownloadState): void {
    if (this.onProgress) {
      this.onProgress(state);
    }
  }
}
