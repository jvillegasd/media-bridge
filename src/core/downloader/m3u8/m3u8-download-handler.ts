/**
 * M3U8 media playlist download handler
 *
 * Downloads videos from standalone M3U8 media playlists (single stream,
 * no quality selection or stream merging). Extends BasePlaylistHandler
 * for shared download/progress/cleanup logic.
 *
 * @module M3u8DownloadHandler
 */

import { CancellationError } from "../../utils/errors";
import { getDownload, storeDownload } from "../../database/downloads";
import { DownloadStage } from "../../types";
import { logger } from "../../utils/logger";
import { parseLevelsPlaylist } from "../../utils/m3u8-parser";
import { getChunkCount } from "../../database/chunks";
import { MessageType } from "../../../shared/messages";
import { processWithFFmpeg } from "../../utils/ffmpeg-bridge";
import { throwIfAborted } from "../../utils/cancellation";
import { canDownloadHLSManifest } from "../../utils/drm-utils";
import { saveBlobUrlToFile } from "../../utils/blob-utils";
import {
  BasePlaylistHandler,
  BasePlaylistHandlerOptions,
} from "../base-playlist-handler";

/** Configuration options for M3U8 download handler */
export type M3u8DownloadHandlerOptions = BasePlaylistHandlerOptions;

/**
 * M3U8 download handler for media playlists
 */
export class M3u8DownloadHandler extends BasePlaylistHandler {
  private fragmentCount: number = 0;

  constructor(options: M3u8DownloadHandlerOptions = {}) {
    super(options);
  }

  protected override resetDownloadState(
    stateId: string,
    abortSignal?: AbortSignal,
  ): void {
    super.resetDownloadState(stateId, abortSignal);
    this.fragmentCount = 0;
  }

  /**
   * Download M3U8 media playlist video
   */
  async download(
    mediaPlaylistUrl: string,
    filename: string,
    stateId: string,
    abortSignal?: AbortSignal,
    pageUrl?: string,
  ): Promise<{ filePath: string; fileExtension?: string }> {
    this.resetDownloadState(stateId, abortSignal);

    const headerRuleIds = await this.tryAddHeaderRules(stateId, mediaPlaylistUrl, pageUrl);

    try {
      logger.info(
        `Starting M3U8 media playlist download from ${mediaPlaylistUrl}`,
      );

      await this.updateProgress(stateId, 0, 0, "Parsing playlist...");

      const mediaPlaylistText = await this.fetchTextCancellable(mediaPlaylistUrl);

      canDownloadHLSManifest(mediaPlaylistText);

      const fragments = parseLevelsPlaylist(
        mediaPlaylistText,
        mediaPlaylistUrl,
      );

      if (fragments.length === 0) {
        throw new Error("No fragments found in media playlist");
      }

      logger.info(`Found ${fragments.length} fragments`);

      throwIfAborted(this.abortSignal);

      await this.downloadAllFragments(fragments, this.downloadId, stateId);

      this.fragmentCount = fragments.length;

      throwIfAborted(this.abortSignal);

      await this.updateStage(stateId, DownloadStage.MERGING, "Merging streams...");

      const baseFileName = this.sanitizeBaseFilename(filename);

      const blobUrl = await processWithFFmpeg({
        requestType: MessageType.OFFSCREEN_PROCESS_M3U8,
        responseType: MessageType.OFFSCREEN_PROCESS_M3U8_RESPONSE,
        downloadId: this.downloadId,
        payload: { fragmentCount: this.fragmentCount },
        filename: baseFileName,
        timeout: this.ffmpegTimeout,
        abortSignal: this.abortSignal,
        onProgress: async (progress, message) => {
          const state = await getDownload(stateId);
          if (state) {
            state.progress.percentage = progress * 100;
            state.progress.message = message;
            state.progress.stage = DownloadStage.MERGING;
            await storeDownload(state);
            this.notifyProgress(state);
          }
        },
      });

      await this.updateStage(stateId, DownloadStage.SAVING, "Saving file...", 95);

      const filePath = await saveBlobUrlToFile(
        blobUrl,
        `${baseFileName}.mp4`,
        stateId,
      );

      await this.markCompleted(stateId, filePath, "Download completed", { verify: true });

      logger.info(`M3U8 media playlist download completed: ${filePath}`);

      return {
        filePath,
        fileExtension: "mp4",
      };
    } catch (error) {
      if (error instanceof CancellationError && this.shouldSaveOnCancel?.()) {
        try {
          const chunkCount = await getChunkCount(this.downloadId);
          this.fragmentCount = chunkCount;

          const result = await this.savePartialDownload(stateId, filename, {
            requestType: MessageType.OFFSCREEN_PROCESS_M3U8,
            responseType: MessageType.OFFSCREEN_PROCESS_M3U8_RESPONSE,
            payload: { fragmentCount: this.fragmentCount },
          });
          logger.info(`M3U8 partial download saved: ${result.filePath}`);
          return result;
        } catch (saveError) {
          if (saveError instanceof CancellationError) {
            // No chunks to save — fall through to throw original error
          } else {
            logger.error("Failed to save partial M3U8 download:", saveError);
          }
        }
      }
      logger.error("M3U8 media playlist download failed:", error);
      throw error;
    } finally {
      await this.tryRemoveHeaderRules(headerRuleIds);
      await this.cleanupChunks(this.downloadId || stateId);
    }
  }
}
