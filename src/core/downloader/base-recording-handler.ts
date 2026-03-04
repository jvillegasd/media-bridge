/**
 * Abstract base class for live stream recording handlers.
 *
 * Extracts the shared polling/recording orchestration pattern used by both
 * HlsRecordingHandler and DashRecordingHandler. Protocol-specific details
 * (manifest resolution, segment discovery, FFmpeg options) are delegated to
 * abstract methods implemented by each subclass.
 *
 * Template method pattern:
 *   record() → resolveMediaUrl() → collectSegments() → fetchNewSegments() → buildFfmpegOptions()
 */

import { DownloadStage, Fragment } from "../types";
import { getDownload, storeDownload } from "../database/downloads";
import { logger } from "../utils/logger";
import { MessageType } from "../../shared/messages";
import { saveBlobUrlToFile } from "../utils/blob-utils";
import { processWithFFmpeg } from "../ffmpeg/ffmpeg-bridge";
import { BasePlaylistHandler } from "./base-playlist-handler";
import { runConcurrentWorkers } from "./concurrent-workers";
import { SAVING_STAGE_PERCENTAGE } from "../../shared/constants";

export abstract class BaseRecordingHandler extends BasePlaylistHandler {
  protected segmentIndex: number = 0;
  protected audioSegmentIndex: number = 0;

  protected override resetDownloadState(
    stateId: string,
    abortSignal?: AbortSignal,
  ): void {
    super.resetDownloadState(stateId, abortSignal);
    this.segmentIndex = 0;
    this.audioSegmentIndex = 0;
  }

  /**
   * Start recording a live stream.
   * Returns after user abort or natural stream end, then merges and saves.
   */
  async record(
    url: string,
    filename: string,
    stateId: string,
    abortSignal: AbortSignal,
    pageUrl?: string,
  ): Promise<{ filePath: string; fileExtension?: string }> {
    this.resetDownloadState(stateId, abortSignal);

    const { mediaUrl, finalUrl } = await this.resolveMediaUrl(url, abortSignal);
    const headerRuleIds = await this.tryAddHeaderRules(stateId, finalUrl, pageUrl);

    try {
      await this.collectSegments(mediaUrl, stateId, abortSignal);

      if (this.segmentIndex === 0) {
        throw new Error("No segments were recorded");
      }

      await this.updateStage(
        stateId,
        DownloadStage.MERGING,
        "Merging recorded segments...",
      );

      const baseFileName = this.sanitizeBaseFilename(filename, "recording");
      const ffmpegOpts = this.buildFfmpegOptions();

      const { blobUrl, warning } = await processWithFFmpeg({
        requestType: ffmpegOpts.requestType,
        responseType: ffmpegOpts.responseType,
        downloadId: this.downloadId,
        payload: ffmpegOpts.payload,
        filename: baseFileName,
        timeout: this.ffmpegTimeout,
        onProgress: this.createMergingProgressCallback(stateId),
      });

      await this.updateStage(
        stateId,
        DownloadStage.SAVING,
        "Saving file...",
        SAVING_STAGE_PERCENTAGE,
      );

      const filePath = await saveBlobUrlToFile(
        blobUrl,
        `${baseFileName}.mp4`,
        stateId,
        this.onBlobReady ? (url) => this.onBlobReady!(url, stateId) : undefined,
      );

      const completionMessage = warning
        ? `Recording saved — ${warning}`
        : "Recording saved";
      await this.markCompleted(stateId, filePath, completionMessage);

      return { filePath, fileExtension: "mp4" };
    } catch (error) {
      logger.error("Recording failed:", error);
      throw error;
    } finally {
      await this.tryRemoveHeaderRules(headerRuleIds);
      await this.cleanupChunks(this.downloadId || stateId);
    }
  }

  // ---------------------------------------------------------------------------
  // Abstract methods — implemented by protocol-specific subclasses
  // ---------------------------------------------------------------------------

  /**
   * Resolve the URL to poll for manifest/playlist updates.
   * Returns both the mediaUrl (URL to poll) and finalUrl (post-redirect URL for DNR header rules).
   * HLS: may follow a master playlist → media playlist redirect.
   * DASH: fetches MPD once to capture response.url, returns original url as mediaUrl.
   */
  protected abstract resolveMediaUrl(
    url: string,
    abortSignal: AbortSignal,
  ): Promise<{ mediaUrl: string; finalUrl: string }>;

  /**
   * Fetch the latest manifest and return new segments not already in seenUris.
   * @param url - the polling URL (media playlist or MPD)
   * @param abortSignal - cancelled when user stops recording
   * @param seenUris - set of segment URIs already downloaded (read-only here)
   * @returns new fragments, poll interval, and whether stream has ended
   */
  protected abstract fetchNewSegments(
    url: string,
    abortSignal: AbortSignal,
    seenUris: Set<string>,
  ): Promise<{ fragments: Fragment[]; audioFragments?: Fragment[]; pollIntervalMs: number; ended: boolean }>;

  /**
   * Return the FFmpeg request/response/payload options for merging.
   */
  protected abstract buildFfmpegOptions(): {
    requestType: MessageType;
    responseType: MessageType;
    payload: Record<string, unknown>;
  };

  // ---------------------------------------------------------------------------
  // Shared helpers
  // ---------------------------------------------------------------------------

  /**
   * Polling loop — fetches new segments until aborted or stream ends.
   */
  protected async collectSegments(
    mediaUrl: string,
    stateId: string,
    abortSignal: AbortSignal,
  ): Promise<void> {
    const seenUris = new Set<string>();
    let pollIntervalMs = 3000;

    logger.info(
      `[REC] Starting polling loop, abortSignal.aborted=${abortSignal.aborted}`,
    );
    let pollCount = 0;

    while (!abortSignal.aborted) {
      pollCount++;

      let result: Awaited<ReturnType<typeof this.fetchNewSegments>>;
      try {
        result = await this.fetchNewSegments(mediaUrl, abortSignal, seenUris);
      } catch (err) {
        if (abortSignal.aborted) break;
        logger.warn(
          "Failed to fetch manifest during recording, retrying...",
          err,
        );
        await this.sleep(pollIntervalMs, abortSignal);
        continue;
      }

      const { fragments: newFragments, audioFragments: newAudioFragments, pollIntervalMs: interval, ended } = result;
      pollIntervalMs = interval;

      if (abortSignal.aborted) break;

      logger.info(
        `[REC] Poll #${pollCount}: new=${newFragments.length}, audio=${newAudioFragments?.length ?? 0}, seen=${seenUris.size}, ended=${ended}`,
      );

      if (newFragments.length > 0) {
        const indexedFragments: Fragment[] = newFragments.map((f) => ({
          ...f,
          index: this.segmentIndex++,
        }));

        indexedFragments.forEach((f) => seenUris.add(f.uri));

        await this.downloadFragmentsConcurrently(indexedFragments, abortSignal);
      }

      if (newAudioFragments && newAudioFragments.length > 0) {
        const indexedAudioFragments: Fragment[] = newAudioFragments.map((f) => ({
          ...f,
          index: this.audioSegmentIndex++,
        }));
        await this.downloadFragmentsConcurrently(
          indexedAudioFragments,
          abortSignal,
          this.downloadId + "_a",
        );
      }

      if (newFragments.length > 0 || (newAudioFragments && newAudioFragments.length > 0)) {
        await this.updateRecordingProgress(stateId);
      }

      if (ended) {
        logger.info("[REC] Stream ended naturally");
        break;
      }

      await this.sleep(pollIntervalMs, abortSignal);
    }

    logger.info(
      `[REC] Polling loop exited after ${pollCount} polls, segments=${this.segmentIndex}, aborted=${abortSignal.aborted}`,
    );
  }

  protected async downloadFragmentsConcurrently(
    fragments: Fragment[],
    abortSignal: AbortSignal,
    storeId?: string,
  ): Promise<void> {
    const targetId = storeId ?? this.downloadId;
    await runConcurrentWorkers({
      items: fragments,
      maxConcurrent: this.maxConcurrent,
      shouldStop: () => abortSignal.aborted,
      processItem: async (fragment) => {
        const size = await this.downloadFragment(fragment, targetId);
        this.bytesDownloaded += size;
      },
      onError: (fragment, err) => {
        logger.warn(`Failed to download segment ${fragment.index}:`, err);
      },
    });
  }

  protected async updateRecordingProgress(stateId: string): Promise<void> {
    const state = await getDownload(stateId);
    if (!state) return;
    state.progress.stage = DownloadStage.RECORDING;
    state.progress.segmentsCollected = this.segmentIndex;
    state.progress.downloaded = this.bytesDownloaded;
    state.progress.message = `${this.segmentIndex} segments collected`;
    state.updatedAt = Date.now();
    await storeDownload(state);
    this.notifyProgress(state);
  }

  protected sleep(ms: number, abortSignal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      if (abortSignal.aborted) {
        resolve();
        return;
      }
      const id = setTimeout(resolve, ms);
      abortSignal.addEventListener(
        "abort",
        () => {
          clearTimeout(id);
          resolve();
        },
        { once: true },
      );
    });
  }
}
