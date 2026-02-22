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
import { fetchText } from "../../utils/fetch-utils";
import { parseLevelsPlaylist } from "../../utils/m3u8-parser";
import { getChunkCount } from "../../database/chunks";
import { MessageType } from "../../../shared/messages";
import { processWithFFmpeg } from "../../utils/ffmpeg-bridge";
import { cancelIfAborted, throwIfAborted } from "../../utils/cancellation";
import { canDownloadHLSManifest } from "../../utils/drm-utils";
import { addHeaderRules, removeHeaderRules } from "../../utils/header-rules";
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

    let headerRuleIds: number[] = [];
    if (pageUrl) {
      try {
        headerRuleIds = await addHeaderRules(stateId, mediaPlaylistUrl, pageUrl);
      } catch (err) {
        logger.warn("Failed to add DNR header rules:", err);
      }
    }

    try {
      logger.info(
        `Starting M3U8 media playlist download from ${mediaPlaylistUrl}`,
      );

      await this.updateProgress(stateId, 0, 0, "Parsing playlist...");

      const mediaPlaylistText = this.abortSignal
        ? await cancelIfAborted(
            fetchText(mediaPlaylistUrl, 3, this.abortSignal),
            this.abortSignal,
          )
        : await fetchText(mediaPlaylistUrl);

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

      const finalState = await getDownload(stateId);
      if (finalState) {
        finalState.localPath = filePath;
        finalState.progress.stage = DownloadStage.COMPLETED;
        finalState.progress.message = "Download completed";
        finalState.progress.percentage = 100;
        finalState.progress.downloaded =
          finalState.progress.total || this.bytesDownloaded || 0;
        finalState.updatedAt = Date.now();
        await storeDownload(finalState);
        this.notifyProgress(finalState);

        await this.verifyCompletedState(stateId);
      } else {
        logger.error(
          `Could not find download state ${stateId} to mark as completed`,
        );
      }

      logger.info(`M3U8 media playlist download completed: ${filePath}`);

      return {
        filePath,
        fileExtension: "mp4",
      };
    } catch (error) {
      if (error instanceof CancellationError && this.shouldSaveOnCancel?.()) {
        try {
          const chunkCount = await getChunkCount(this.downloadId);
          if (chunkCount > 0) {
            await this.updateStage(
              stateId,
              DownloadStage.MERGING,
              "Merging partial download...",
            );

            this.fragmentCount = chunkCount;
            this.abortSignal = undefined;

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

            await this.updateStage(
              stateId,
              DownloadStage.SAVING,
              "Saving partial file...",
              95,
            );

            const filePath = await saveBlobUrlToFile(
              blobUrl,
              `${baseFileName}.mp4`,
              stateId,
            );

            const finalState = await getDownload(stateId);
            if (finalState) {
              finalState.localPath = filePath;
              finalState.progress.stage = DownloadStage.COMPLETED;
              finalState.progress.message = "Download completed (partial)";
              finalState.progress.percentage = 100;
              finalState.progress.downloaded =
                finalState.progress.total || this.bytesDownloaded || 0;
              finalState.updatedAt = Date.now();
              await storeDownload(finalState);
              this.notifyProgress(finalState);
            }

            logger.info(`M3U8 partial download saved: ${filePath}`);
            return { filePath, fileExtension: "mp4" };
          }
        } catch (saveError) {
          logger.error("Failed to save partial M3U8 download:", saveError);
        }
      }
      logger.error("M3U8 media playlist download failed:", error);
      throw error;
    } finally {
      try {
        await removeHeaderRules(headerRuleIds);
      } catch (cleanupError) {
        logger.error("Failed to remove DNR header rules:", cleanupError);
      }

      await this.cleanupChunks(this.downloadId || stateId);
    }
  }
}
