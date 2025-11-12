/**
 * Direct download handler - orchestrates direct video downloads using Chrome downloads API
 */

import { DirectDownloader } from "./direct-downloader";
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
} from "../types";

export class DirectDownloadHandler {
  private readonly onProgress?: DownloadProgressCallback;

  constructor(options: DirectDownloadHandlerOptions = {}) {
    this.onProgress = options.onProgress;
  }

  /**
   * Download direct video using Chrome downloads API and return file path with extracted metadata
   */
  async download(
    url: string,
    filename: string,
    stateId: string,
  ): Promise<DirectDownloadHandlerResult> {
    const directDownloader = new DirectDownloader({
      onProgress: async (loaded, total, percentage) => {
        logger.info(`Direct download: ${percentage.toFixed(2)}%`);

        // Get current download state by ID to update progress
        const currentState = await DownloadStateManager.getDownload(stateId);
        if (currentState) {
          currentState.progress.downloaded = loaded;
          currentState.progress.total = total;
          currentState.progress.percentage = percentage;
          currentState.progress.stage = "downloading";
          currentState.progress.message = "Downloading...";

          await DownloadStateManager.saveDownload(currentState);
          this.notifyProgress(currentState);
        }
      },
    });

    // Get metadata from HTTP headers (HEAD request) before downloading
    let fileExtension: string | undefined;
    try {
      const response = await fetch(url, { method: "HEAD" });
      const contentType = response.headers.get("content-type") || "";
      fileExtension =
        detectExtensionFromUrl(url) ||
        detectExtensionFromContentType(contentType);
    } catch (error) {
      logger.warn(`Failed to get headers for ${url}:`, error);
      // Fallback to URL-based detection
      fileExtension = detectExtensionFromUrl(url);
    }

    // Download using Chrome downloads API
    const result = await directDownloader.download(url, filename);

    // Update state with extracted metadata, file path, and mark as completed
    const currentState = await DownloadStateManager.getDownload(stateId);
    if (currentState) {
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

    return {
      filePath: result.filePath,
      fileExtension,
    };
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
