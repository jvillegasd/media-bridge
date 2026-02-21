/**
 * HLS live recording handler
 *
 * Polls a live HLS manifest at a fixed interval, collects new segments as they
 * appear, stores them in IndexedDB, and — when the user stops recording (or when
 * #EXT-X-ENDLIST is detected) — hands off to the existing M3U8/FFmpeg merge path
 * to produce an MP4 file.
 *
 * The handler is controlled via an AbortSignal:
 *   - Normal abort (user clicks STOP) → polling loop exits, merge begins.
 *   - #EXT-X-ENDLIST detected         → polling loop exits naturally, merge begins.
 */

import { DownloadState, DownloadStage, Fragment, Level } from "../../types";
import { getDownload, storeDownload } from "../../database/downloads";
import { storeChunk, deleteChunks } from "../../database/chunks";
import { createOffscreenDocument } from "../../utils/offscreen-manager";
import { fetchText, fetchArrayBuffer } from "../../utils/fetch-utils";
import { decryptFragment } from "../../utils/crypto-utils";
import {
  parseMasterPlaylist,
  parseLevelsPlaylist,
} from "../../utils/m3u8-parser";
import { sanitizeFilename } from "../../utils/file-utils";
import { logger } from "../../utils/logger";
import { CancellationError } from "../../utils/errors";
import { MessageType } from "../../../shared/messages";
import { DownloadProgressCallback } from "../types";

const POLL_INTERVAL_MS = 3000;

export interface HlsRecordingHandlerOptions {
  onProgress?: DownloadProgressCallback;
  maxConcurrent?: number;
  ffmpegTimeout?: number;
}

export class HlsRecordingHandler {
  private readonly onProgress?: DownloadProgressCallback;
  private readonly maxConcurrent: number;
  private readonly ffmpegTimeout: number;
  private downloadId: string = "";
  private bytesDownloaded: number = 0;
  private segmentIndex: number = 0;

  constructor(options: HlsRecordingHandlerOptions = {}) {
    this.onProgress = options.onProgress;
    this.maxConcurrent = options.maxConcurrent || 3;
    this.ffmpegTimeout = options.ffmpegTimeout || 900000;
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
  ): Promise<{ filePath: string; fileExtension?: string }> {
    this.downloadId = stateId;
    this.bytesDownloaded = 0;
    this.segmentIndex = 0;

    try {
      // Resolve media playlist URL (handles master → variant selection)
      const mediaPlaylistUrl = await this.resolveMediaPlaylistUrl(
        manifestUrl,
        abortSignal,
      );

      // Polling loop — collect segments until user stops or stream ends
      await this.collectSegments(mediaPlaylistUrl, stateId, abortSignal);

      if (this.segmentIndex === 0) {
        throw new Error("No segments were recorded");
      }

      // Transition to MERGING stage
      await this.updateStage(stateId, DownloadStage.MERGING, "Merging recorded segments...");

      const sanitizedFilename = sanitizeFilename(filename);
      let baseFileName = sanitizedFilename.replace(/\.[^/.]+$/, "");
      if (!baseFileName || baseFileName.trim() === "") {
        baseFileName = `recording_${Date.now()}`;
      }

      const blobUrl = await this.mergeToMp4(baseFileName, stateId);

      // Transition to SAVING stage
      await this.updateStage(stateId, DownloadStage.SAVING, "Saving file...", 95);

      const finalFilename = `${baseFileName}.mp4`;
      const filePath = await this.saveBlobUrl(blobUrl, finalFilename, stateId);

      // Mark completed
      const finalState = await getDownload(stateId);
      if (finalState) {
        finalState.localPath = filePath;
        finalState.progress.stage = DownloadStage.COMPLETED;
        finalState.progress.message = "Recording saved";
        finalState.progress.percentage = 100;
        finalState.updatedAt = Date.now();
        await storeDownload(finalState);
        this.notifyProgress(finalState);
      }

      logger.info(`HLS recording completed: ${filePath}`);
      return { filePath, fileExtension: "mp4" };
    } catch (error) {
      logger.error("HLS recording failed:", error);
      throw error;
    } finally {
      try {
        await deleteChunks(this.downloadId || stateId);
      } catch (cleanupError) {
        logger.error("Failed to clean up recording chunks:", cleanupError);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * If `url` points to a master playlist, auto-select the best video variant.
   * Otherwise, return `url` as-is (it is already a media playlist).
   */
  private async resolveMediaPlaylistUrl(
    url: string,
    abortSignal: AbortSignal,
  ): Promise<string> {
    const text = await fetchText(url, 3, abortSignal);

    // Detect master playlist by presence of #EXT-X-STREAM-INF
    if (!text.includes("#EXT-X-STREAM-INF")) {
      return url;
    }

    const levels = parseMasterPlaylist(text, url);
    const videoLevels = levels.filter((l) => l.type === "stream");
    if (videoLevels.length === 0) {
      return url;
    }

    // Pick highest bitrate variant
    videoLevels.sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
    return videoLevels[0]!.uri;
  }

  /**
   * Poll the media playlist and download any new segments.
   * Exits when abortSignal fires or #EXT-X-ENDLIST is present.
   */
  private async collectSegments(
    mediaPlaylistUrl: string,
    stateId: string,
    abortSignal: AbortSignal,
  ): Promise<void> {
    const seenUris = new Set<string>();

    while (!abortSignal.aborted) {
      let playlistText: string;
      try {
        playlistText = await fetchText(mediaPlaylistUrl, 3, abortSignal);
      } catch (err) {
        if (abortSignal.aborted) break;
        logger.warn("Failed to fetch manifest during recording, retrying...", err);
        await this.sleep(POLL_INTERVAL_MS, abortSignal);
        continue;
      }

      if (abortSignal.aborted) break;

      // Parse new fragments
      const allFragments = parseLevelsPlaylist(playlistText, mediaPlaylistUrl);
      const newFragments = allFragments.filter((f) => !seenUris.has(f.uri));

      if (newFragments.length > 0) {
        // Assign sequential global indices
        const indexedFragments: Fragment[] = newFragments.map((f) => ({
          ...f,
          index: this.segmentIndex++,
        }));

        // Mark URIs as seen before downloading to avoid double-download on retry
        indexedFragments.forEach((f) => seenUris.add(f.uri));

        await this.downloadFragmentsConcurrently(
          indexedFragments,
          abortSignal,
        );

        // Update progress
        await this.updateRecordingProgress(stateId);
      }

      // Check for end-of-stream marker
      const hasEndList = playlistText.includes("#EXT-X-ENDLIST");
      if (hasEndList) {
        logger.info("HLS stream ended naturally (#EXT-X-ENDLIST detected)");
        break;
      }

      // Wait before next poll
      await this.sleep(POLL_INTERVAL_MS, abortSignal);
    }
  }

  /**
   * Download a batch of fragments with concurrency limiting.
   */
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
          const data = await fetchArrayBuffer(fragment.uri, 3, abortSignal);
          const decrypted = await decryptFragment(
            fragment.key,
            data,
            3,
            abortSignal,
          );
          await storeChunk(this.downloadId, fragment.index, decrypted);
          this.bytesDownloaded += decrypted.byteLength;
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

  /**
   * Update the download state to show recording progress.
   */
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

  /**
   * Set stage + optional message / percentage and persist.
   */
  private async updateStage(
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

  /**
   * Send collected segments to the offscreen document for FFmpeg muxing.
   * Reuses the existing OFFSCREEN_PROCESS_M3U8 path.
   */
  private async mergeToMp4(fileName: string, stateId: string): Promise<string> {
    await createOffscreenDocument();

    return new Promise<string>((resolve, reject) => {
      let timeoutId: ReturnType<typeof setTimeout> | null = null;
      let isSettled = false;

      const cleanup = () => {
        if (timeoutId) {
          clearTimeout(timeoutId);
          timeoutId = null;
        }
        chrome.runtime.onMessage.removeListener(messageListener);
      };

      const messageListener = (message: any) => {
        if (
          message.type !== MessageType.OFFSCREEN_PROCESS_M3U8_RESPONSE ||
          message.payload?.downloadId !== this.downloadId
        ) {
          return;
        }

        const { type, blobUrl, error, progress, message: msg } = message.payload;

        if (type === "success") {
          if (isSettled) return;
          isSettled = true;
          cleanup();
          resolve(blobUrl);
        } else if (type === "error") {
          if (isSettled) return;
          isSettled = true;
          cleanup();
          reject(new Error(error || "FFmpeg processing failed"));
        } else if (type === "progress") {
          // Forward merging progress updates
          getDownload(stateId).then((state) => {
            if (!state) return;
            state.progress.percentage = (progress || 0) * 100;
            state.progress.message = msg || "Merging...";
            state.progress.stage = DownloadStage.MERGING;
            storeDownload(state).then(() => this.notifyProgress(state));
          });
        }
      };

      chrome.runtime.onMessage.addListener(messageListener);

      chrome.runtime.sendMessage(
        {
          type: MessageType.OFFSCREEN_PROCESS_M3U8,
          payload: {
            downloadId: this.downloadId,
            fragmentCount: this.segmentIndex,
            filename: fileName,
          },
        },
        () => {
          if (chrome.runtime.lastError) {
            if (isSettled) return;
            isSettled = true;
            cleanup();
            reject(
              new Error(
                `Failed to send processing request: ${chrome.runtime.lastError.message}`,
              ),
            );
          }
        },
      );

      timeoutId = setTimeout(() => {
        if (isSettled) return;
        isSettled = true;
        cleanup();
        reject(new Error("FFmpeg processing timeout"));
      }, this.ffmpegTimeout);
    });
  }

  /**
   * Save a blob URL via chrome.downloads and wait for completion.
   */
  private async saveBlobUrl(
    blobUrl: string,
    filename: string,
    stateId: string,
  ): Promise<string> {
    try {
      return await new Promise<string>((resolve, reject) => {
        chrome.downloads.download(
          { url: blobUrl, filename, saveAs: false },
          async (downloadId) => {
            if (chrome.runtime.lastError) {
              reject(new Error(chrome.runtime.lastError.message));
              return;
            }

            const currentState = await getDownload(stateId);
            if (currentState) {
              currentState.chromeDownloadId = downloadId!;
              await storeDownload(currentState);
            }

            const checkComplete = () => {
              chrome.downloads.search({ id: downloadId }, (results) => {
                if (chrome.runtime.lastError) {
                  reject(new Error(chrome.runtime.lastError.message));
                  return;
                }
                const item = results?.[0];
                if (!item) {
                  reject(new Error("Download item not found"));
                  return;
                }
                if (item.state === "complete") {
                  chrome.runtime.sendMessage(
                    { type: MessageType.REVOKE_BLOB_URL, payload: { blobUrl } },
                    () => { if (chrome.runtime.lastError) {} },
                  );
                  resolve(item.filename);
                } else if (item.state === "interrupted") {
                  chrome.runtime.sendMessage(
                    { type: MessageType.REVOKE_BLOB_URL, payload: { blobUrl } },
                    () => { if (chrome.runtime.lastError) {} },
                  );
                  reject(new Error(item.error || "Download interrupted"));
                } else {
                  setTimeout(checkComplete, 100);
                }
              });
            };

            checkComplete();
          },
        );
      });
    } catch (error) {
      chrome.runtime.sendMessage(
        { type: MessageType.REVOKE_BLOB_URL, payload: { blobUrl } },
        () => { if (chrome.runtime.lastError) {} },
      );
      throw error;
    }
  }

  private notifyProgress(state: DownloadState): void {
    if (this.onProgress) {
      this.onProgress(state);
    }
  }

  private sleep(ms: number, abortSignal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      if (abortSignal.aborted) {
        resolve();
        return;
      }
      const id = setTimeout(resolve, ms);
      abortSignal.addEventListener("abort", () => {
        clearTimeout(id);
        resolve();
      }, { once: true });
    });
  }
}
