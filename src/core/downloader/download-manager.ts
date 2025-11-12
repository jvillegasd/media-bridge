/**
 * Main download manager that orchestrates downloads
 */

import { VideoFormat, VideoMetadata, DownloadState } from "../types";
import { DownloadStateManager } from "../storage/download-state";
import { DownloadError } from "../utils/errors";
import { logger } from "../utils/logger";
import { DownloadProgressCallback } from "./types";
import { detectExtensionFromUrl, detectExtensionFromContentType } from "../metadata/metadata-extractor";

export interface DownloadManagerOptions {
  maxConcurrent?: number;
  onProgress?: DownloadProgressCallback;
  uploadToDrive?: boolean;
}

export class DownloadManager {
  private readonly maxConcurrent: number;
  private readonly onProgress?: DownloadProgressCallback;
  private readonly uploadToDrive: boolean;
  private downloadProgressListeners: Map<number, string> = new Map(); // chromeDownloadId -> stateId
  private downloadCompletionPromises: Map<number, { resolve: (path: string) => void; reject: (error: Error) => void }> = new Map(); // chromeDownloadId -> promise resolvers

  constructor(options: DownloadManagerOptions = {}) {
    this.maxConcurrent = options.maxConcurrent || 3;
    this.onProgress = options.onProgress;
    this.uploadToDrive = options.uploadToDrive || false;
    
    // Set up Chrome downloads progress tracking
    this.setupDownloadProgressTracking();
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
      let state = await this.createInitialDownloadState(
        downloadId,
        url,
        metadata,
      );

      // Validate format from metadata (should already be set by detection)
      if (metadata.format === "unknown") {
        const error = new Error(`Video format is unknown for URL: ${url}`);
        return await this.createFailedState(
          state.id,
          url,
          state.metadata,
          state.createdAt,
          error,
        );
      }

      const format = metadata.format;
      state.progress.stage = "downloading";
      state.progress.message = `Format: ${format}`;
      await DownloadStateManager.saveDownload(state);
      this.notifyProgress(state);

      // metadata.url is always the actual video URL
      const actualVideoUrl = metadata.url;

      // Get metadata from HTTP headers (HEAD request)
      const headerMetadata = await this.getMetadataFromHeaders(actualVideoUrl);
      
      // Update metadata if we got extension from headers
      if (headerMetadata.extension) {
        state.metadata = {
          ...state.metadata,
          fileExtension: headerMetadata.extension,
        };
        await DownloadStateManager.saveDownload(state);
      }

      // Use direct URL with Chrome downloads API (most efficient - no blob download)
      // Progress tracking and completion are handled by Chrome downloads API listeners
      await this.saveFileToDisk(actualVideoUrl, filename, state);

      // Get final state (may have been updated by progress tracking)
      const finalState = await DownloadStateManager.getDownload(state.id);
      return finalState || state;
    } catch (error) {
      logger.error("Download failed:", error);
      await this.createFailedState(
        downloadId,
        url,
        metadata,
        Date.now(),
        error,
      );
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
   * Get metadata from HTTP headers (HEAD request)
   */
  private async getMetadataFromHeaders(url: string): Promise<{ extension?: string; total?: number }> {
    try {
      const response = await fetch(url, { method: 'HEAD' });
      const contentType = response.headers.get('content-type') || '';
      const contentLength = response.headers.get('content-length');
      
      const extension = detectExtensionFromUrl(url) || detectExtensionFromContentType(contentType);
      const total = contentLength ? parseInt(contentLength, 10) : undefined;
      
      return { extension, total };
    } catch (error) {
      logger.warn(`Failed to get headers for ${url}:`, error);
      // Fallback to URL-based detection
      const extension = detectExtensionFromUrl(url);
      return { extension };
    }
  }

  /**
   * Set up Chrome downloads progress tracking
   */
  private setupDownloadProgressTracking(): void {
    chrome.downloads.onChanged.addListener((downloadDelta) => {
      const chromeDownloadId = downloadDelta.id;
      const stateId = this.downloadProgressListeners.get(chromeDownloadId);
      
      if (!stateId) {
        return; // Not one of our tracked downloads
      }

      // Update progress on any change (bytesReceived, state, etc.)
      // This ensures we get frequent updates for progress bar
      this.updateProgressFromChromeDownload(chromeDownloadId, stateId, downloadDelta).catch((error) => {
        logger.error(`Error updating progress for download ${chromeDownloadId}:`, error);
      });
    });
  }

  /**
   * Update progress from Chrome download state
   */
  private async updateProgressFromChromeDownload(
    chromeDownloadId: number,
    stateId: string,
    delta: chrome.downloads.DownloadDelta,
  ): Promise<void> {
    const state = await DownloadStateManager.getDownload(stateId);
    if (!state) {
      return;
    }

    // Get current download item
    const downloadItem = await new Promise<chrome.downloads.DownloadItem | null>((resolve) => {
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

    // For direct downloads: just keep total file size, clear other progress values
    // Chrome's download bar already shows all progress info
    state.progress.percentage = undefined;
    state.progress.speed = undefined;
    state.progress.downloaded = undefined;
    
    if (downloadItem.totalBytes) {
      state.progress.total = downloadItem.totalBytes;
    }
    
    if (state.progress.stage === 'downloading' && 
        (!state.progress.message || state.progress.message === 'Starting download...')) {
      state.progress.message = 'Downloading...';
    }

    // Update stage based on state
    if (delta.state) {
      if (delta.state.current === 'in_progress') {
        state.progress.stage = 'downloading';
        if (!state.progress.message || state.progress.message === 'Starting download...') {
          state.progress.message = 'Downloading...';
        }
      } else if (delta.state.current === 'complete') {
        state.progress.stage = 'completed';
        state.progress.message = 'Download completed';
        state.localPath = downloadItem.filename;
        this.downloadProgressListeners.delete(chromeDownloadId);
        
        // Resolve completion promise if waiting
        const completionPromise = this.downloadCompletionPromises.get(chromeDownloadId);
        if (completionPromise) {
          completionPromise.resolve(downloadItem.filename);
          this.downloadCompletionPromises.delete(chromeDownloadId);
        }
      } else if (delta.state.current === 'interrupted') {
        state.progress.stage = 'failed';
        state.progress.error = downloadItem.error || 'Download interrupted';
        state.progress.message = `Download failed: ${downloadItem.error || 'Unknown error'}`;
        this.downloadProgressListeners.delete(chromeDownloadId);
        
        // Reject completion promise if waiting
        const completionPromise = this.downloadCompletionPromises.get(chromeDownloadId);
        if (completionPromise) {
          completionPromise.reject(new Error(downloadItem.error || 'Download interrupted'));
          this.downloadCompletionPromises.delete(chromeDownloadId);
        }
      }
    }

    await DownloadStateManager.saveDownload(state);
    this.notifyProgress(state);
  }

  /**
   * Save file to disk using Chrome downloads API with direct URL
   * This is the most efficient approach - no blob download, Chrome handles everything
   */
  private async saveFileToDisk(
    url: string,
    filename: string,
    state: DownloadState,
  ): Promise<void> {
    state.progress.stage = "downloading";
    state.progress.message = "Starting download...";
    await DownloadStateManager.saveDownload(state);
    this.notifyProgress(state);

    // Use Chrome downloads API with direct URL (most efficient)
    logger.info(`Starting download with direct URL: ${url}`);
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

    // Track this download for progress updates
    this.downloadProgressListeners.set(chromeDownloadId, state.id);
    
    // Wait for download to complete using onChanged callback (no polling needed)
    const localPath = await new Promise<string>((resolve, reject) => {
      // Store promise resolvers for onChanged callback to use
      this.downloadCompletionPromises.set(chromeDownloadId, { resolve, reject });
      
      // Set timeout as fallback in case onChanged doesn't fire
      setTimeout(() => {
        if (this.downloadCompletionPromises.has(chromeDownloadId)) {
          this.downloadCompletionPromises.delete(chromeDownloadId);
          reject(new Error('Download timeout - completion event not received'));
        }
      }, 300000); // 5 minute timeout
    });

    state.localPath = localPath;
  }

  /**
   * Create and save a failed download state
   */
  private async createFailedState(
    downloadId: string,
    url: string,
    metadata: VideoMetadata,
    createdAt: number,
    error: unknown,
  ): Promise<DownloadState> {
    const errorMessage = error instanceof Error ? error.message : String(error);

    const failedState: DownloadState = {
      id: downloadId,
      url,
      metadata,
      progress: {
        url,
        stage: "failed",
        error: errorMessage,
      },
      createdAt,
      updatedAt: Date.now(),
    };

    await DownloadStateManager.saveDownload(failedState);
    this.notifyProgress(failedState);

    return failedState;
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
