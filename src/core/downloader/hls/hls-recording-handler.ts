/**
 * HLS live recording handler
 *
 * Polls a live HLS manifest at a fixed interval, collects new segments as they
 * appear, stores them in IndexedDB, and — when the user stops recording (or when
 * #EXT-X-ENDLIST is detected) — hands off to the existing M3U8/FFmpeg merge path
 * to produce an MP4 file.
 *
 * Extends BasePlaylistHandler for shared constructor, state, notifyProgress,
 * sanitizeBaseFilename, updateStage, and cleanupChunks.
 *
 * The handler is controlled via an AbortSignal:
 *   - Normal abort (user clicks STOP) → polling loop exits, merge begins.
 *   - #EXT-X-ENDLIST detected         → polling loop exits naturally, merge begins.
 */

import { DownloadStage, Fragment } from "../../types";
import { getDownload, storeDownload } from "../../database/downloads";
import { fetchText } from "../../utils/fetch-utils";
import {
  parseMasterPlaylist,
  parseLevelsPlaylist,
} from "../../utils/m3u8-parser";
import { logger } from "../../utils/logger";
import { CancellationError } from "../../utils/errors";
import { MessageType } from "../../../shared/messages";
import { saveBlobUrlToFile } from "../../utils/blob-utils";
import { processWithFFmpeg } from "../../utils/ffmpeg-bridge";
import { BasePlaylistHandler } from "../base-playlist-handler";

const POLL_INTERVAL_MS = 3000;

export class HlsRecordingHandler extends BasePlaylistHandler {
  private segmentIndex: number = 0;

  protected override resetDownloadState(
    stateId: string,
    abortSignal?: AbortSignal,
  ): void {
    super.resetDownloadState(stateId, abortSignal);
    this.segmentIndex = 0;
  }

  /**
   * Start recording a live HLS stream.
   * Returns when the user aborts or #EXT-X-ENDLIST is detected,
   * then merges collected segments and saves the file.
   */
  async record(
    manifestUrl: string,
    filename: string,
    stateId: string,
    abortSignal: AbortSignal,
    pageUrl?: string,
  ): Promise<{ filePath: string; fileExtension?: string }> {
    this.resetDownloadState(stateId, abortSignal);

    const headerRuleIds = await this.tryAddHeaderRules(stateId, manifestUrl, pageUrl);

    try {
      const mediaPlaylistUrl = await this.resolveMediaPlaylistUrl(
        manifestUrl,
        abortSignal,
      );

      await this.collectSegments(mediaPlaylistUrl, stateId, abortSignal);

      if (this.segmentIndex === 0) {
        throw new Error("No segments were recorded");
      }

      await this.updateStage(
        stateId,
        DownloadStage.MERGING,
        "Merging recorded segments...",
      );

      const baseFileName = this.sanitizeBaseFilename(filename, "recording");

      const { blobUrl, warning } = await processWithFFmpeg({
        requestType: MessageType.OFFSCREEN_PROCESS_M3U8,
        responseType: MessageType.OFFSCREEN_PROCESS_M3U8_RESPONSE,
        downloadId: this.downloadId,
        payload: { fragmentCount: this.segmentIndex },
        filename: baseFileName,
        timeout: this.ffmpegTimeout,
        onProgress: this.createMergingProgressCallback(stateId),
      });

      await this.updateStage(
        stateId,
        DownloadStage.SAVING,
        "Saving file...",
        95,
      );

      const finalFilename = `${baseFileName}.mp4`;
      const filePath = await saveBlobUrlToFile(blobUrl, finalFilename, stateId);

      const completionMessage = warning
        ? `Recording saved — ${warning}`
        : "Recording saved";
      await this.markCompleted(stateId, filePath, completionMessage);

      logger.info(`HLS recording completed: ${filePath}`);
      return { filePath, fileExtension: "mp4" };
    } catch (error) {
      logger.error("HLS recording failed:", error);
      throw error;
    } finally {
      await this.tryRemoveHeaderRules(headerRuleIds);
      await this.cleanupChunks(this.downloadId || stateId);
    }
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private async resolveMediaPlaylistUrl(
    url: string,
    abortSignal: AbortSignal,
  ): Promise<string> {
    const text = await fetchText(url, 3, abortSignal);

    if (!text.includes("#EXT-X-STREAM-INF")) {
      logger.info(
        `[REC] URL is already a media playlist: ${url.substring(0, 100)}...`,
      );
      return url;
    }

    const levels = parseMasterPlaylist(text, url);
    const videoLevels = levels.filter((l) => l.type === "stream");
    if (videoLevels.length === 0) {
      logger.warn(
        `[REC] No video levels found in master playlist, using URL as-is`,
      );
      return url;
    }

    videoLevels.sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
    const resolvedUrl = videoLevels[0]!.uri;
    logger.info(
      `[REC] Resolved media playlist: ${resolvedUrl.substring(0, 100)}...`,
    );
    return resolvedUrl;
  }

  private async collectSegments(
    mediaPlaylistUrl: string,
    stateId: string,
    abortSignal: AbortSignal,
  ): Promise<void> {
    const seenUris = new Set<string>();

    logger.info(
      `[REC] Starting polling loop, abortSignal.aborted=${abortSignal.aborted}`,
    );
    let pollCount = 0;

    while (!abortSignal.aborted) {
      pollCount++;
      let playlistText: string;
      try {
        playlistText = await fetchText(mediaPlaylistUrl, 3, abortSignal, true);
      } catch (err) {
        if (abortSignal.aborted) break;
        logger.warn(
          "Failed to fetch manifest during recording, retrying...",
          err,
        );
        await this.sleep(POLL_INTERVAL_MS, abortSignal);
        continue;
      }

      if (abortSignal.aborted) break;

      logger.info(
        `[REC] Poll #${pollCount}: playlist length=${playlistText.length}, aborted=${abortSignal.aborted}`,
      );

      const allFragments = parseLevelsPlaylist(playlistText, mediaPlaylistUrl);
      const newFragments = allFragments.filter((f) => !seenUris.has(f.uri));

      logger.info(
        `[REC] Poll #${pollCount}: total fragments=${allFragments.length}, new=${newFragments.length}, seen=${seenUris.size}`,
      );

      if (newFragments.length > 0) {
        const indexedFragments: Fragment[] = newFragments.map((f) => ({
          ...f,
          index: this.segmentIndex++,
        }));

        indexedFragments.forEach((f) => seenUris.add(f.uri));

        await this.downloadFragmentsConcurrently(indexedFragments, abortSignal);

        await this.updateRecordingProgress(stateId);
      }

      const hasEndList = playlistText.includes("#EXT-X-ENDLIST");
      logger.info(`[REC] Poll #${pollCount}: hasEndList=${hasEndList}`);
      if (hasEndList) {
        logger.info("HLS stream ended naturally (#EXT-X-ENDLIST detected)");
        break;
      }

      await this.sleep(POLL_INTERVAL_MS, abortSignal);
    }
    logger.info(
      `[REC] Polling loop exited after ${pollCount} polls, segments=${this.segmentIndex}, aborted=${abortSignal.aborted}`,
    );
  }

  private async downloadFragmentsConcurrently(
    fragments: Fragment[],
    abortSignal: AbortSignal,
  ): Promise<void> {
    let idx = 0;
    const errors: Error[] = [];

    const worker = async (): Promise<void> => {
      while (idx < fragments.length) {
        if (abortSignal.aborted) return;
        const fragment = fragments[idx++]!;
        try {
          const size = await this.downloadFragment(fragment, this.downloadId);
          this.bytesDownloaded += size;
        } catch (err) {
          if (err instanceof CancellationError || abortSignal.aborted) return;
          const e = err instanceof Error ? err : new Error(String(err));
          errors.push(e);
          logger.warn(`Failed to download segment ${fragment.index}:`, e);
        }
      }
    };

    const workers = Array.from(
      { length: Math.min(this.maxConcurrent, fragments.length) },
      () => worker(),
    );
    await Promise.all(workers);
  }

  private async updateRecordingProgress(stateId: string): Promise<void> {
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

  private sleep(ms: number, abortSignal: AbortSignal): Promise<void> {
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
