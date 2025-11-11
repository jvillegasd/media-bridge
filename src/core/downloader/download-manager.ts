/**
 * Main download manager that orchestrates downloads
 */

import { VideoFormat, VideoMetadata, DownloadState } from "../types";
import { FormatDetector } from "../detection/format-detector";
import { DirectDownloadHandler } from "./direct/direct-download-handler";
import { DownloadStateManager } from "../storage/download-state";
import { DownloadError } from "../utils/errors";
import { logger } from "../utils/logger";
import {
  FormatDetectionResult,
  DownloadResult,
  DownloadProgressCallback,
  ok,
  err,
} from "./types";

export interface DownloadManagerOptions {
  maxConcurrent?: number;
  onProgress?: DownloadProgressCallback;
  uploadToDrive?: boolean;
}

export class DownloadManager {
  private readonly maxConcurrent: number;
  private readonly onProgress?: DownloadProgressCallback;
  private readonly uploadToDrive: boolean;

  constructor(options: DownloadManagerOptions = {}) {
    this.maxConcurrent = options.maxConcurrent || 3;
    this.onProgress = options.onProgress;
    this.uploadToDrive = options.uploadToDrive || false;
  }

  /**
   * Download video from URL
   */
  async download(
    url: string,
    filename: string,
    metadata: VideoMetadata,
  ): Promise<DownloadState> {
    const downloadId = this.generateDownloadId(url);

    try {
      // Create and initialize download state
      let state = await this.createInitialDownloadState(downloadId, url, metadata);

      // Detect format and validate
      const formatResult = await this.detectAndValidateFormat(
        url,
        state,
        metadata,
      );
      if (!formatResult.ok) {
        return formatResult.error;
      }

      const { format, state: updatedState } = formatResult.data;
      state = updatedState;

      // metadata.url is always the actual video URL
      const actualVideoUrl = metadata.url;

      // Execute download
      const { blob: finalBlob, extractedMetadata } = await this.executeDownload(
        actualVideoUrl,
        state.id,
      );

      // Get updated state with metadata (already updated by DirectDownloadHandler)
      const latestState = await DownloadStateManager.getDownload(state.id);
      if (latestState) {
        state = latestState;
      }

      // Save file to disk
      await this.saveFileToDisk(finalBlob, filename, state);

      // Complete download
      const completedState = await this.completeDownload(state);

      return completedState;
    } catch (error) {
      await this.handleDownloadError(downloadId, url, metadata, error);
      throw error; // Re-throw after handling
    }
  }

  /**
   * Create initial download state
   */
  private async createInitialDownloadState(
    downloadId: string,
    url: string,
    metadata: VideoMetadata,
  ): Promise<DownloadState> {
    const state: DownloadState = {
      id: downloadId,
      url,
      metadata,
      progress: {
        url,
        stage: "detecting",
        percentage: 0,
      },
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    await DownloadStateManager.saveDownload(state);
    this.notifyProgress(state);

    return state;
  }

  /**
   * Detect format and validate, updating state accordingly
   */
  private async detectAndValidateFormat(
    url: string,
    state: DownloadState,
    metadata: VideoMetadata,
  ): Promise<FormatDetectionResult> {
    logger.info(`Detecting format for ${url}`);
    const format: VideoFormat = FormatDetector.detectFromUrl(url);

    if (format === "unknown") {
      const failedState: DownloadState = {
        id: state.id,
        url,
        metadata: state.metadata,
        progress: {
          url,
          stage: "failed",
          error: `Could not determine video format for URL: ${url}`,
        },
        createdAt: state.createdAt,
        updatedAt: Date.now(),
      };
      await DownloadStateManager.saveDownload(failedState);
      this.notifyProgress(failedState);
      return err(failedState);
    }

    logger.info(`Detected format: ${format} for URL: ${url}`);

    // Merge provided metadata with detected format
    state.metadata = {
      ...metadata,
      format,
    };
    state.progress.stage = "downloading";
    state.progress.message = `Detected format: ${format}`;

    await DownloadStateManager.saveDownload(state);
    this.notifyProgress(state);

    return ok({ format, state });
  }

  /**
   * Execute the actual download using appropriate handler
   */
  private async executeDownload(
    url: string,
    stateId: string,
  ): Promise<DownloadResult> {
    const directHandler = new DirectDownloadHandler({
      onProgress: async (directState) => {
        // Update our state with direct download progress
        const currentState = await DownloadStateManager.getDownload(stateId);
        if (currentState) {
          currentState.progress = directState.progress;
          await DownloadStateManager.saveDownload(currentState);
          this.notifyProgress(currentState);
        }
      },
    });

    return await directHandler.download(url, stateId);
  }

  /**
   * Save file to disk using Chrome downloads API
   */
  private async saveFileToDisk(
    blob: Blob,
    filename: string,
    state: DownloadState,
  ): Promise<void> {
    state.progress.stage = "saving";
    state.progress.message = "Saving file...";
    await DownloadStateManager.saveDownload(state);
    this.notifyProgress(state);

    // Create blob URL
    const blobUrl = URL.createObjectURL(blob);

    try {
      // Use Chrome downloads API to save file
      const chromeDownloadId = await new Promise<number>((resolve, reject) => {
        chrome.downloads.download(
          {
            url: blobUrl,
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
      await this.waitForDownload(chromeDownloadId);

      // Get final download path
      const downloadItem = await new Promise<chrome.downloads.DownloadItem>(
        (resolve, reject) => {
          chrome.downloads.search({ id: chromeDownloadId }, (results) => {
            if (chrome.runtime.lastError) {
              reject(new Error(chrome.runtime.lastError.message));
            } else if (results && results[0]) {
              resolve(results[0]);
            } else {
              reject(new Error("Download not found"));
            }
          });
        },
      );

      state.localPath = downloadItem.filename;
    } finally {
      // Revoke blob URL to free memory
      URL.revokeObjectURL(blobUrl);
    }
  }

  /**
   * Complete download and update final state
   */
  private async completeDownload(state: DownloadState): Promise<DownloadState> {
    state.progress.stage = "completed";
    state.progress.percentage = 100;
    state.progress.message = "Download completed";

    await DownloadStateManager.saveDownload(state);
    this.notifyProgress(state);

    // Note: Google Drive upload would need to be handled separately
    // as we can't easily read the downloaded file back
    // The blob is available in finalBlob, but it's already saved
    // A better approach would be to upload first, then save, or store blob for upload

    return state;
  }

  /**
   * Handle download errors and create failed state
   */
  private async handleDownloadError(
    downloadId: string,
    url: string,
    metadata: VideoMetadata,
    error: unknown,
  ): Promise<void> {
    logger.error("Download failed:", error);

    const failedState: DownloadState = {
      id: downloadId,
      url,
      metadata,
      progress: {
        url,
        stage: "failed",
        error: error instanceof Error ? error.message : String(error),
      },
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    await DownloadStateManager.saveDownload(failedState);
    this.notifyProgress(failedState);
  }

  /**
   * Wait for Chrome download to complete
   */
  private waitForDownload(downloadId: chrome.downloads.DownloadItem["id"]): Promise<void> {
    return new Promise((resolve, reject) => {
      const checkDownload = () => {
        chrome.downloads.search({ id: downloadId }, (results) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
            return;
          }

          if (!results || results.length === 0) {
            reject(new Error("Download not found"));
            return;
          }

          const item = results[0];
          if (item.state === "complete") {
            resolve();
          } else if (item.state === "interrupted") {
            reject(new Error(`Download interrupted: ${item.error}`));
          } else {
            setTimeout(checkDownload, 500);
          }
        });
      };

      checkDownload();
    });
  }

  /**
   * Generate download ID
   */
  private generateDownloadId(url: string): string {
    return `dl_${Date.now()}_${url
      .substring(0, 20)
      .replace(/[^a-z0-9]/gi, "")}`;
  }

  /**
   * Notify progress
   */
  private notifyProgress(state: DownloadState): void {
    if (this.onProgress) {
      this.onProgress(state);
    }
  }
}
