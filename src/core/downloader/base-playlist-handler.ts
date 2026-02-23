/**
 * Abstract base class for playlist-based download handlers.
 *
 * Extracts shared state fields, constructor logic, and utility methods
 * from HlsDownloadHandler, M3u8DownloadHandler, and HlsRecordingHandler.
 */

import { CancellationError } from "../utils/errors";
import { cancelIfAborted, throwIfAborted } from "../utils/cancellation";
import { getDownload, storeDownload } from "../database/downloads";
import { DownloadState, Fragment, DownloadStage } from "../types";
import { logger } from "../utils/logger";
import { decryptFragment } from "../utils/crypto-utils";
import { fetchArrayBuffer, fetchText } from "../utils/fetch-utils";
import { storeChunk, deleteChunks, getChunkCount } from "../database/chunks";
import { sanitizeFilename } from "../utils/file-utils";
import { formatFileSize } from "../utils/format-utils";
import { DownloadProgressCallback } from "./types";
import { MessageType } from "../../shared/messages";
import { processWithFFmpeg } from "../utils/ffmpeg-bridge";
import { saveBlobUrlToFile } from "../utils/blob-utils";
import { addHeaderRules, removeHeaderRules } from "../utils/header-rules";
import {
  DEFAULT_MAX_CONCURRENT,
  DEFAULT_FFMPEG_TIMEOUT_MS,
  MAX_FRAGMENT_FAILURE_RATE,
  SAVING_STAGE_PERCENTAGE,
} from "../../shared/constants";

export interface BasePlaylistHandlerOptions {
  onProgress?: DownloadProgressCallback;
  maxConcurrent?: number;
  ffmpegTimeout?: number;
  shouldSaveOnCancel?: () => boolean;
}

export abstract class BasePlaylistHandler {
  protected readonly onProgress?: DownloadProgressCallback;
  protected readonly maxConcurrent: number;
  protected readonly ffmpegTimeout: number;
  protected readonly shouldSaveOnCancel?: () => boolean;

  protected downloadId: string = "";
  protected bytesDownloaded: number = 0;
  protected totalBytes: number = 0;
  protected lastUpdateTime: number = 0;
  protected lastDownloadedBytes: number = 0;
  protected abortSignal?: AbortSignal;
  private smoothedSpeed: number = 0;
  private cachedState: DownloadState | null = null;
  private lastDbSyncTime: number = 0;
  private static readonly SPEED_EMA_ALPHA = 0.3;
  private static readonly DB_SYNC_INTERVAL_MS = 500;

  constructor(options: BasePlaylistHandlerOptions = {}) {
    this.onProgress = options.onProgress;
    this.maxConcurrent = options.maxConcurrent || DEFAULT_MAX_CONCURRENT;
    this.ffmpegTimeout = options.ffmpegTimeout || DEFAULT_FFMPEG_TIMEOUT_MS;
    this.shouldSaveOnCancel = options.shouldSaveOnCancel;
  }

  // ---- Shared utility methods ----

  protected notifyProgress(state: DownloadState): void {
    if (this.onProgress) {
      this.onProgress(state);
    }
  }

  protected resetDownloadState(
    stateId: string,
    abortSignal?: AbortSignal,
  ): void {
    this.downloadId = stateId;
    this.bytesDownloaded = 0;
    this.totalBytes = 0;
    this.lastUpdateTime = 0;
    this.lastDownloadedBytes = 0;
    this.abortSignal = abortSignal;
    this.smoothedSpeed = 0;
    this.cachedState = null;
    this.lastDbSyncTime = 0;
  }

  protected async updateProgress(
    stateId: string,
    downloadedBytes: number,
    totalBytes: number,
    message?: string,
  ): Promise<void> {
    throwIfAborted(this.abortSignal);

    const now = Date.now();

    // Calculate speed with exponential moving average for smoother display
    if (this.lastUpdateTime > 0 && this.lastDownloadedBytes > 0) {
      const timeDelta = (now - this.lastUpdateTime) / 1000;
      const bytesDelta = downloadedBytes - this.lastDownloadedBytes;
      if (timeDelta > 0) {
        const currentSpeed = bytesDelta / timeDelta;
        this.smoothedSpeed =
          BasePlaylistHandler.SPEED_EMA_ALPHA * currentSpeed +
          (1 - BasePlaylistHandler.SPEED_EMA_ALPHA) * this.smoothedSpeed;
      }
    }

    this.lastUpdateTime = now;
    this.lastDownloadedBytes = downloadedBytes;
    this.bytesDownloaded = downloadedBytes;
    this.totalBytes = totalBytes;

    // Use cached state to reduce DB reads; sync to DB on a throttled interval
    if (!this.cachedState) {
      this.cachedState = await getDownload(stateId);
      if (!this.cachedState) return;
    }

    const state = this.cachedState;
    const percentage =
      totalBytes > 0 ? (downloadedBytes / totalBytes) * 100 : 0;
    state.progress.downloaded = downloadedBytes;
    state.progress.total = totalBytes;
    state.progress.percentage = percentage;
    state.progress.stage = DownloadStage.DOWNLOADING;
    state.progress.message =
      message ||
      `Downloaded ${formatFileSize(downloadedBytes)}/${formatFileSize(totalBytes)}`;
    state.progress.speed = this.smoothedSpeed;
    state.progress.lastUpdateTime = now;
    state.progress.lastDownloaded = downloadedBytes;

    // Throttle DB writes to reduce I/O during fragment downloads
    if (now - this.lastDbSyncTime >= BasePlaylistHandler.DB_SYNC_INTERVAL_MS) {
      this.lastDbSyncTime = now;
      await storeDownload(state);
    }
    this.notifyProgress(state);
  }

  protected sanitizeBaseFilename(
    filename: string,
    fallbackPrefix: string = "video",
  ): string {
    const sanitized = sanitizeFilename(filename);
    let base = sanitized.replace(/\.[^/.]+$/, "");
    if (!base || base.trim() === "") {
      base = `${fallbackPrefix}_${Date.now()}`;
      logger.warn(
        `Filename became empty after sanitization, using fallback: ${base}`,
      );
    }
    return base;
  }

  protected createMergingProgressCallback(
    stateId: string,
  ): (progress: number, message: string) => Promise<void> {
    return async (progress: number, message: string) => {
      const state = await getDownload(stateId);
      if (!state) return;
      state.progress.percentage = progress * 100;
      state.progress.message = message;
      state.progress.stage = DownloadStage.MERGING;
      await storeDownload(state);
      this.notifyProgress(state);
    };
  }

  protected async updateStage(
    stateId: string,
    stage: DownloadStage,
    message: string,
    percentage?: number,
  ): Promise<void> {
    // Invalidate cached state on stage transitions
    this.cachedState = null;
    const state = await getDownload(stateId);
    if (!state) return;
    state.progress.stage = stage;
    state.progress.message = message;
    if (percentage !== undefined) state.progress.percentage = percentage;
    state.updatedAt = Date.now();
    await storeDownload(state);
    this.notifyProgress(state);
  }

  protected async cleanupChunks(downloadId: string): Promise<void> {
    try {
      await deleteChunks(downloadId);
      logger.info(`Cleaned up chunks for download ${downloadId}`);
    } catch (cleanupError) {
      logger.error("Failed to clean up chunks:", cleanupError);
    }
  }

  protected async tryAddHeaderRules(
    stateId: string,
    url: string,
    pageUrl?: string,
  ): Promise<number[]> {
    if (!pageUrl) return [];
    try {
      return await addHeaderRules(stateId, url, pageUrl);
    } catch (err) {
      logger.warn("Failed to add DNR header rules:", err);
      return [];
    }
  }

  protected async tryRemoveHeaderRules(ruleIds: number[]): Promise<void> {
    try {
      await removeHeaderRules(ruleIds);
    } catch (cleanupError) {
      logger.error("Failed to remove DNR header rules:", cleanupError);
    }
  }

  protected async fetchTextCancellable(
    url: string,
    retries: number = 3,
  ): Promise<string> {
    if (!this.abortSignal) {
      throw new Error("AbortSignal is required for cancellable fetch");
    }
    return cancelIfAborted(
      fetchText(url, retries, this.abortSignal),
      this.abortSignal,
    );
  }

  protected async downloadFragment(
    fragment: Fragment,
    downloadId: string,
    fetchAttempts: number = 3,
  ): Promise<number> {
    if (!this.abortSignal) {
      throw new Error("AbortSignal is required for fragment download");
    }

    const data = await cancelIfAborted(
      fetchArrayBuffer(fragment.uri, fetchAttempts, this.abortSignal),
      this.abortSignal,
    );

    const decryptedData = await cancelIfAborted(
      decryptFragment(fragment.key, data, fetchAttempts, this.abortSignal),
      this.abortSignal,
    );

    await storeChunk(downloadId, fragment.index, decryptedData);
    return decryptedData.byteLength;
  }

  protected async downloadAllFragments(
    fragments: Fragment[],
    downloadId: string,
    stateId: string,
  ): Promise<void> {
    const totalFragments = fragments.length;
    let downloadedFragments = 0;
    let sessionBytesDownloaded = 0;
    const errors: Error[] = [];

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
          this.abortSignal,
        );

        sessionBytesDownloaded += firstFragmentSize;
        downloadedFragments++;
        this.bytesDownloaded += firstFragmentSize;

        estimatedTotalBytes = firstFragmentSize * totalFragments;
        if (this.totalBytes > 0) {
          estimatedTotalBytes +=
            this.totalBytes - this.bytesDownloaded + firstFragmentSize;
        }
        this.totalBytes = Math.max(this.totalBytes, estimatedTotalBytes);

        await cancelIfAborted(
          this.updateProgress(
            stateId,
            this.bytesDownloaded,
            this.totalBytes,
            `Downloading fragments...`,
          ),
          this.abortSignal!,
        );
      } catch (error) {
        logger.error(
          `Failed to download first fragment for size estimation:`,
          error,
        );
        estimatedTotalBytes = 0;
      }
    }

    const downloadQueue: Promise<void>[] = [];
    let currentIndex = 1;

    const downloadNext = async (): Promise<void> => {
      if (!this.abortSignal) {
        throw new Error("AbortSignal is required for fragment downloads");
      }

      while (currentIndex < totalFragments) {
        throwIfAborted(this.abortSignal);

        const fragmentIndex = currentIndex++;
        const fragment = fragments[fragmentIndex];

        if (!fragment) {
          logger.warn(
            `Fragment at index ${fragmentIndex} is undefined, skipping`,
          );
          continue;
        }

        try {
          const fragmentSize = await cancelIfAborted(
            this.downloadFragment(fragment, downloadId),
            this.abortSignal,
          );

          sessionBytesDownloaded += fragmentSize;
          downloadedFragments++;
          this.bytesDownloaded += fragmentSize;

          if (estimatedTotalBytes === 0 || downloadedFragments > 0) {
            const averageFragmentSize =
              sessionBytesDownloaded / downloadedFragments;
            const sessionEstimatedTotal = averageFragmentSize * totalFragments;
            const previousBytes = this.bytesDownloaded - sessionBytesDownloaded;
            estimatedTotalBytes = previousBytes + sessionEstimatedTotal;
            this.totalBytes = Math.max(this.totalBytes, estimatedTotalBytes);
          }

          await cancelIfAborted(
            this.updateProgress(
              stateId,
              this.bytesDownloaded,
              this.totalBytes,
              `Downloading fragments...`,
            ),
            this.abortSignal,
          );
        } catch (error) {
          if (error instanceof CancellationError) {
            throw error;
          }

          const err =
            error instanceof Error ? error : new Error(String(error));
          errors.push(err);
          logger.error(
            `Fragment ${fragment?.index ?? fragmentIndex} failed:`,
            err,
          );
        }
      }
    };

    for (
      let i = 0;
      i < Math.min(this.maxConcurrent, totalFragments - downloadedFragments);
      i++
    ) {
      downloadQueue.push(downloadNext());
    }

    const results = await Promise.allSettled(downloadQueue);

    const cancelledError = results.find(
      (result) =>
        result.status === "rejected" &&
        result.reason instanceof CancellationError,
    );

    if (cancelledError) {
      throw new CancellationError();
    }

    throwIfAborted(this.abortSignal);

    this.totalBytes = Math.max(this.totalBytes, this.bytesDownloaded);
    await cancelIfAborted(
      this.updateProgress(
        stateId,
        this.bytesDownloaded,
        this.totalBytes,
        `Downloaded ${downloadedFragments}/${totalFragments} fragments`,
      ),
      this.abortSignal!,
    );

    if (errors.length > 0 && downloadedFragments === 0) {
      throw new Error(
        `Failed to download any fragments: ${errors[0].message}`,
      );
    }

    if (downloadedFragments < totalFragments) {
      const failedCount = totalFragments - downloadedFragments;
      const failureRate = failedCount / totalFragments;
      logger.warn(
        `Downloaded ${downloadedFragments}/${totalFragments} fragments (${failedCount} failed).`,
      );
      // Abort if more than 10% of fragments failed — output would be too corrupted
      if (failureRate > MAX_FRAGMENT_FAILURE_RATE) {
        throw new Error(
          `Too many fragment failures: ${failedCount}/${totalFragments} failed (${Math.round(failureRate * 100)}%). Aborting to avoid corrupted output.`,
        );
      }
    }
  }

  protected async savePartialDownload(
    stateId: string,
    filename: string,
    ffmpegOptions: {
      requestType: MessageType;
      responseType: MessageType;
      payload: Record<string, unknown>;
    },
  ): Promise<{ filePath: string; fileExtension: string }> {
    const chunkCount = await getChunkCount(this.downloadId);
    if (chunkCount === 0) {
      throw new CancellationError();
    }

    await this.updateStage(
      stateId,
      DownloadStage.MERGING,
      "Merging partial download...",
    );

    this.abortSignal = undefined;

    const baseFileName = this.sanitizeBaseFilename(filename);

    const { blobUrl, warning } = await processWithFFmpeg({
      requestType: ffmpegOptions.requestType,
      responseType: ffmpegOptions.responseType,
      downloadId: this.downloadId,
      payload: ffmpegOptions.payload,
      filename: baseFileName,
      timeout: this.ffmpegTimeout,
      abortSignal: this.abortSignal,
      onProgress: this.createMergingProgressCallback(stateId),
    });

    await this.updateStage(
      stateId,
      DownloadStage.SAVING,
      "Saving partial file...",
      SAVING_STAGE_PERCENTAGE,
    );

    const filePath = await saveBlobUrlToFile(
      blobUrl,
      `${baseFileName}.mp4`,
      stateId,
    );

    const completionMessage = warning
      ? `Download completed (partial) — ${warning}`
      : "Download completed (partial)";
    await this.markCompleted(stateId, filePath, completionMessage);

    return { filePath, fileExtension: "mp4" };
  }

  protected async markCompleted(
    stateId: string,
    filePath: string,
    message: string = "Download completed",
  ): Promise<void> {
    this.cachedState = null;
    const state = await getDownload(stateId);
    if (state) {
      state.localPath = filePath;
      state.progress.stage = DownloadStage.COMPLETED;
      state.progress.message = message;
      state.progress.percentage = 100;
      state.progress.downloaded =
        state.progress.total || this.bytesDownloaded || 0;
      state.updatedAt = Date.now();
      await storeDownload(state);
      this.notifyProgress(state);
    } else {
      logger.error(
        `Could not find download state ${stateId} to mark as completed`,
      );
    }
  }
}
