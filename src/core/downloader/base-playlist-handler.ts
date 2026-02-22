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
import { fetchArrayBuffer } from "../utils/fetch-utils";
import { storeChunk, deleteChunks } from "../database/chunks";
import { sanitizeFilename } from "../utils/file-utils";
import { formatFileSize } from "../utils/format-utils";
import { DownloadProgressCallback } from "./types";

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

  constructor(options: BasePlaylistHandlerOptions = {}) {
    this.onProgress = options.onProgress;
    this.maxConcurrent = options.maxConcurrent || 3;
    this.ffmpegTimeout = options.ffmpegTimeout || 900000;
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
  }

  protected async updateProgress(
    stateId: string,
    downloadedBytes: number,
    totalBytes: number,
    message?: string,
  ): Promise<void> {
    throwIfAborted(this.abortSignal);

    const state = await getDownload(stateId);
    if (!state) return;

    const now = Date.now();
    let speed = 0;

    if (this.lastUpdateTime > 0 && this.lastDownloadedBytes > 0) {
      const timeDelta = (now - this.lastUpdateTime) / 1000;
      const bytesDelta = downloadedBytes - this.lastDownloadedBytes;
      if (timeDelta > 0) {
        speed = bytesDelta / timeDelta;
      }
    }

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
      `Downloaded ${formatFileSize(downloadedBytes)}/${formatFileSize(totalBytes)}`;
    state.progress.speed = speed;
    state.progress.lastUpdateTime = now;
    state.progress.lastDownloaded = downloadedBytes;

    await storeDownload(state);
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

  protected async updateStage(
    stateId: string,
    stage: DownloadStage,
    message: string,
    percentage?: number,
  ): Promise<void> {
    const state = await getDownload(stateId);
    if (!state) return;
    state.progress.stage = stage;
    state.progress.message = message;
    if (percentage !== undefined) state.progress.percentage = percentage;
    state.updatedAt = Date.now();
    await storeDownload(state);
    this.notifyProgress(state);
  }

  protected async verifyCompletedState(stateId: string): Promise<void> {
    const verifyState = await getDownload(stateId);
    if (
      verifyState &&
      verifyState.progress.stage !== DownloadStage.COMPLETED
    ) {
      logger.warn(`State verification failed for ${stateId}, retrying...`);
      verifyState.progress.stage = DownloadStage.COMPLETED;
      verifyState.progress.message = "Download completed";
      verifyState.progress.percentage = 100;
      await storeDownload(verifyState);
      this.notifyProgress(verifyState);
    }
  }

  protected async cleanupChunks(downloadId: string): Promise<void> {
    try {
      await deleteChunks(downloadId);
      logger.info(`Cleaned up chunks for download ${downloadId}`);
    } catch (cleanupError) {
      logger.error("Failed to clean up chunks:", cleanupError);
    }
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

        if (this.abortSignal) {
          await cancelIfAborted(
            this.updateProgress(
              stateId,
              this.bytesDownloaded,
              this.totalBytes,
              `Downloading fragments...`,
            ),
            this.abortSignal,
          );
        } else {
          await this.updateProgress(
            stateId,
            this.bytesDownloaded,
            this.totalBytes,
            `Downloading fragments...`,
          );
        }
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
    if (this.abortSignal) {
      await cancelIfAborted(
        this.updateProgress(
          stateId,
          this.bytesDownloaded,
          this.totalBytes,
          `Downloaded ${downloadedFragments}/${totalFragments} fragments`,
        ),
        this.abortSignal,
      );
    } else {
      await this.updateProgress(
        stateId,
        this.bytesDownloaded,
        this.totalBytes,
        `Downloaded ${downloadedFragments}/${totalFragments} fragments`,
      );
    }

    if (errors.length > 0 && downloadedFragments === 0) {
      throw new Error(
        `Failed to download any fragments: ${errors[0].message}`,
      );
    }

    if (downloadedFragments < totalFragments) {
      logger.warn(
        `Downloaded ${downloadedFragments}/${totalFragments} fragments. Some fragments failed.`,
      );
    }
  }
}
