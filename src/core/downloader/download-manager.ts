/**
 * Main download manager that orchestrates video downloads
 * Routes downloads to format-specific handlers (direct, HLS, M3U8)
 */

import { VideoFormat, VideoMetadata, DownloadState, DownloadStage } from "../types";
import {
  getDownload,
  storeDownload,
  updateDownloadProgress,
} from "../database/downloads";
import { DownloadError } from "../utils/errors";
import { generateDownloadId } from "../utils/id-utils";
import { logger } from "../utils/logger";
import { DownloadProgressCallback } from "./types";
import { DirectDownloadHandler } from "./direct/direct-download-handler";
import { HlsDownloadHandler } from "./hls/hls-download-handler";
import { M3u8DownloadHandler } from "./m3u8/m3u8-download-handler";

/**
 * Configuration options for the DownloadManager
 */
export interface DownloadManagerOptions {
  /** Maximum number of concurrent downloads/chunks @default 3 */
  maxConcurrent?: number;

  /** Optional callback for download progress updates */
  onProgress?: DownloadProgressCallback;

  /** Whether to upload completed downloads to Google Drive @default false */
  uploadToDrive?: boolean;

  /** FFmpeg processing timeout in milliseconds @default 900000 (15 minutes) */
  ffmpegTimeout?: number;

  /** When cancelled, save partial progress instead of discarding */
  shouldSaveOnCancel?: () => boolean;
}

/**
 * Main download manager that orchestrates video downloads
 * Routes downloads to format-specific handlers and manages state
 */
export class DownloadManager {
  private readonly maxConcurrent: number;
  private readonly onProgress?: DownloadProgressCallback;
  private readonly uploadToDrive: boolean;
  private readonly directDownloadHandler: DirectDownloadHandler;
  private readonly hlsDownloadHandler: HlsDownloadHandler;
  private readonly m3u8DownloadHandler: M3u8DownloadHandler;

  /**
   * Creates a new DownloadManager instance
   * @param options - Configuration options
   */
  constructor(options: DownloadManagerOptions = {}) {
    this.maxConcurrent = options.maxConcurrent || 3;
    this.onProgress = options.onProgress;
    this.uploadToDrive = options.uploadToDrive || false;
    const ffmpegTimeout = options.ffmpegTimeout || 900000; // Default 15 minutes

    // Initialize direct download handler
    this.directDownloadHandler = new DirectDownloadHandler({
      onProgress: this.onProgress,
    });

    // Initialize HLS download handler
    this.hlsDownloadHandler = new HlsDownloadHandler({
      onProgress: this.onProgress,
      maxConcurrent: this.maxConcurrent,
      ffmpegTimeout,
      shouldSaveOnCancel: options.shouldSaveOnCancel,
    });

    // Initialize M3U8 download handler
    this.m3u8DownloadHandler = new M3u8DownloadHandler({
      onProgress: this.onProgress,
      maxConcurrent: this.maxConcurrent,
      ffmpegTimeout,
      shouldSaveOnCancel: options.shouldSaveOnCancel,
    });
  }

  /**
   * Downloads a video from the given URL
   * Routes to format-specific handler based on metadata.format
   * @param url - Original URL where video was detected
   * @param filename - Desired filename for downloaded video
   * @param metadata - Video metadata with format and URL
   * @param manifestQuality - Optional manifest quality selection (for HLS format)
   * @returns Promise resolving to final DownloadState
   * @throws {Error} If format is unknown/unsupported or download fails
   */
  async download(
    url: string,
    filename: string,
    metadata: VideoMetadata,
    manifestQuality?: {
      videoPlaylistUrl?: string | null;
      audioPlaylistUrl?: string | null;
    },
    isManual?: boolean,
    abortSignal?: AbortSignal,
  ): Promise<DownloadState> {
    const downloadId = generateDownloadId(url);

    try {
      // Create and initialize download state
      let state = await this.createInitialDownloadState(
        downloadId,
        url,
        metadata,
        isManual,
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
      state.progress.stage = DownloadStage.DOWNLOADING;
      state.progress.message = `Format: ${format}`;
      await storeDownload(state);
      this.notifyProgress(state);

      // metadata.url is always the actual video URL
      const actualVideoUrl = metadata.url;

      // Route to appropriate download handler based on format
      if (format === "direct") {
        // Use direct download handler with Chrome downloads API
        // AbortSignal is used to cancel the HEAD request for extension detection
        // The actual Chrome download is cancelled via chrome.downloads.cancel
        await this.directDownloadHandler.download(
          actualVideoUrl,
          filename,
          state.id,
          abortSignal,
        );
      } else if (format === "hls") {
        // Use HLS download handler
        await this.hlsDownloadHandler.download(
          actualVideoUrl,
          filename,
          state.id,
          manifestQuality,
          abortSignal,
          metadata.pageUrl,
        );
      } else if (format === "m3u8") {
        // Use M3U8 download handler
        await this.m3u8DownloadHandler.download(
          actualVideoUrl,
          filename,
          state.id,
          abortSignal,
          metadata.pageUrl,
        );
      } else {
        throw new Error(`Unsupported format: ${format}`);
      }

      // Get final state (may have been updated by progress tracking)
      const finalState = await getDownload(state.id);
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
   * Creates and persists initial download state
   * @private
   */
  private async createInitialDownloadState(
    downloadId: string,
    url: string,
    metadata: VideoMetadata,
    isManual?: boolean,
  ): Promise<DownloadState> {
    const state: DownloadState = {
      id: downloadId,
      url,
      metadata,
      progress: {
        url,
        stage: DownloadStage.DETECTING,
        percentage: 0,
      },
      isManual,
      // chromeDownloadId will be set when Chrome downloads API is used (direct downloads or HLS/M3U8 final save)
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    await storeDownload(state);
    this.notifyProgress(state);

    return state;
  }

  /**
   * Creates and persists failed download state
   * @private
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
        stage: DownloadStage.FAILED,
        error: errorMessage,
      },
      // chromeDownloadId may not be set if download failed before Chrome API was used
      createdAt,
      updatedAt: Date.now(),
    };

    await storeDownload(failedState);
    this.notifyProgress(failedState);

    return failedState;
  }


  /**
   * Notifies progress callback if configured
   * @private
   */
  private notifyProgress(state: DownloadState): void {
    if (this.onProgress) {
      this.onProgress(state);
    }
  }
}
