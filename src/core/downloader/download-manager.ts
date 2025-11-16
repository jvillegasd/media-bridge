/**
 * Main download manager that orchestrates downloads
 */

import { VideoFormat, VideoMetadata, DownloadState } from "../types";
import { DownloadStateManager } from "../storage/download-state";
import { DownloadError } from "../utils/errors";
import { logger } from "../utils/logger";
import { DownloadProgressCallback } from "./types";
import { DirectDownloadHandler } from "./direct/direct-download-handler";
import { HlsDownloadHandler } from "./hls/hls-download-handler";
import { M3u8DownloadHandler } from "./m3u8/m3u8-download-handler";

export interface DownloadManagerOptions {
  maxConcurrent?: number;
  onProgress?: DownloadProgressCallback;
  uploadToDrive?: boolean;
}

export class DownloadManager {
  private readonly maxConcurrent: number;
  private readonly onProgress?: DownloadProgressCallback;
  private readonly uploadToDrive: boolean;
  private readonly directDownloadHandler: DirectDownloadHandler;
  private readonly hlsDownloadHandler: HlsDownloadHandler;
  private readonly m3u8DownloadHandler: M3u8DownloadHandler;

  constructor(options: DownloadManagerOptions = {}) {
    this.maxConcurrent = options.maxConcurrent || 3;
    this.onProgress = options.onProgress;
    this.uploadToDrive = options.uploadToDrive || false;

    // Initialize direct download handler
    this.directDownloadHandler = new DirectDownloadHandler({
      onProgress: this.onProgress,
    });

    // Initialize HLS download handler
    this.hlsDownloadHandler = new HlsDownloadHandler({
      onProgress: this.onProgress,
      maxConcurrent: this.maxConcurrent,
    });

    // Initialize M3U8 download handler
    this.m3u8DownloadHandler = new M3u8DownloadHandler({
      onProgress: this.onProgress,
      maxConcurrent: this.maxConcurrent,
    });
  }

  /**
   * Download video from URL
   */
  async download(
    url: string,
    filename: string,
    metadata: VideoMetadata,
    hlsQuality?: {
      videoPlaylistUrl?: string | null;
      audioPlaylistUrl?: string | null;
    },
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

      // Route to appropriate download handler based on format
      if (format === "direct") {
        // Use direct download handler with Chrome downloads API
        await this.directDownloadHandler.download(
          actualVideoUrl,
          filename,
          state.id,
        );
      } else if (format === "hls") {
        // Use HLS download handler
        await this.hlsDownloadHandler.download(
          actualVideoUrl,
          filename,
          state.id,
          hlsQuality,
        );
      } else if (format === "m3u8") {
        // Use M3U8 download handler
        await this.m3u8DownloadHandler.download(
          actualVideoUrl,
          filename,
          state.id,
        );
      } else {
        throw new Error(`Unsupported format: ${format}`);
      }

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
