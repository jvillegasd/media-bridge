/**
 * HLS download handler - orchestrates HLS video downloads from master playlists.
 *
 * Extends BasePlaylistHandler for shared download/progress/cleanup logic.
 * Unique to this handler: master playlist parsing, dual video+audio streams,
 * quality selection, and HLS-specific FFmpeg processing.
 *
 * @module HlsDownloadHandler
 */

import { CancellationError } from "../../utils/errors";
import { cancelIfAborted, throwIfAborted } from "../../utils/cancellation";
import { getDownload, storeDownload } from "../../database/downloads";
import { Level, DownloadStage } from "../../types";
import { logger } from "../../utils/logger";
import { fetchText } from "../../utils/fetch-utils";
import {
  parseMasterPlaylist,
  parseLevelsPlaylist,
} from "../../utils/m3u8-parser";
import { getChunkCount } from "../../database/chunks";
import { MessageType } from "../../../shared/messages";
import { processWithFFmpeg } from "../../utils/ffmpeg-bridge";
import { canDownloadHLSManifest } from "../../utils/drm-utils";
import { sanitizeFilename } from "../../utils/file-utils";
import { addHeaderRules, removeHeaderRules } from "../../utils/header-rules";
import { saveBlobUrlToFile } from "../../utils/blob-utils";
import {
  BasePlaylistHandler,
  BasePlaylistHandlerOptions,
} from "../base-playlist-handler";

/** Configuration options for HLS download handler */
export type HlsDownloadHandlerOptions = BasePlaylistHandlerOptions;

/**
 * HLS download handler for master playlists
 * Supports auto quality selection or manual quality selection
 */
export class HlsDownloadHandler extends BasePlaylistHandler {
  private videoLength: number = 0;
  private audioLength: number = 0;

  constructor(options: HlsDownloadHandlerOptions = {}) {
    super(options);
  }

  protected override resetDownloadState(
    stateId: string,
    abortSignal?: AbortSignal,
  ): void {
    super.resetDownloadState(stateId, abortSignal);
    this.videoLength = 0;
    this.audioLength = 0;
  }

  private selectLevels(levels: Level[]): {
    video: string | null;
    audio: string | null;
  } {
    const videoLevels = levels.filter((level) => level.type === "stream");
    const audioLevels = levels.filter((level) => level.type === "audio");

    let videoUri: string | null = null;
    if (videoLevels.length > 0) {
      videoLevels.sort((a, b) => {
        if (a.bitrate && b.bitrate) {
          return b.bitrate - a.bitrate;
        }
        if (a.height && b.height) {
          return b.height - a.height;
        }
        return 0;
      });
      videoUri = videoLevels[0]?.uri || null;
    }

    const audioUri =
      audioLevels.length > 0 ? audioLevels[0]?.uri || null : null;

    return { video: videoUri, audio: audioUri };
  }

  /**
   * Download HLS video from master playlist
   */
  async download(
    masterPlaylistUrl: string,
    filename: string,
    stateId: string,
    manifestQuality?: {
      videoPlaylistUrl?: string | null;
      audioPlaylistUrl?: string | null;
    },
    abortSignal?: AbortSignal,
    pageUrl?: string,
  ): Promise<{ filePath: string; fileExtension?: string }> {
    this.resetDownloadState(stateId, abortSignal);

    let headerRuleIds: number[] = [];
    if (pageUrl) {
      try {
        headerRuleIds = await addHeaderRules(stateId, masterPlaylistUrl, pageUrl);
      } catch (err) {
        logger.warn("Failed to add DNR header rules:", err);
      }
    }

    try {
      logger.info(`Starting HLS download from ${masterPlaylistUrl}`);

      await this.updateProgress(stateId, 0, 0, "Parsing playlist...");

      let videoPlaylistUrl: string | null = null;
      let audioPlaylistUrl: string | null = null;
      let videoPlaylistText: string | null = null;
      let audioPlaylistText: string | null = null;

      const masterPlaylistText = this.abortSignal
        ? await cancelIfAborted(
            fetchText(masterPlaylistUrl, 3, this.abortSignal),
            this.abortSignal,
          )
        : await fetchText(masterPlaylistUrl);

      canDownloadHLSManifest(masterPlaylistText);

      if (manifestQuality) {
        videoPlaylistUrl = manifestQuality.videoPlaylistUrl || null;
        audioPlaylistUrl = manifestQuality.audioPlaylistUrl || null;
        logger.info(
          `Using provided quality preferences - video: ${
            videoPlaylistUrl || "none"
          }, audio: ${audioPlaylistUrl || "none"}`,
        );

        if (videoPlaylistUrl) {
          videoPlaylistText = this.abortSignal
            ? await cancelIfAborted(
                fetchText(videoPlaylistUrl, 3, this.abortSignal),
                this.abortSignal,
              )
            : await fetchText(videoPlaylistUrl);
          canDownloadHLSManifest(videoPlaylistText);
        }

        if (audioPlaylistUrl) {
          audioPlaylistText = this.abortSignal
            ? await cancelIfAborted(
                fetchText(audioPlaylistUrl, 3, this.abortSignal),
                this.abortSignal,
              )
            : await fetchText(audioPlaylistUrl);
          canDownloadHLSManifest(audioPlaylistText);
        }
      } else {
        const levels = parseMasterPlaylist(
          masterPlaylistText,
          masterPlaylistUrl,
        );

        if (levels.length === 0) {
          throw new Error("No levels found in master playlist");
        }

        const selected = this.selectLevels(levels);
        videoPlaylistUrl = selected.video;
        audioPlaylistUrl = selected.audio;
        logger.info(
          `Auto-selected video: ${videoPlaylistUrl || "none"}, audio: ${
            audioPlaylistUrl || "none"
          }`,
        );
      }

      if (!videoPlaylistUrl && !audioPlaylistUrl) {
        throw new Error("No video or audio levels found in master playlist");
      }

      throwIfAborted(this.abortSignal);

      // Process video playlist
      if (videoPlaylistUrl) {
        if (!videoPlaylistText) {
          videoPlaylistText = this.abortSignal
            ? await cancelIfAborted(
                fetchText(videoPlaylistUrl, 3, this.abortSignal),
                this.abortSignal,
              )
            : await fetchText(videoPlaylistUrl);
          canDownloadHLSManifest(videoPlaylistText);
        }

        const videoFragments = parseLevelsPlaylist(
          videoPlaylistText,
          videoPlaylistUrl,
        );

        if (videoFragments.length === 0) {
          throw new Error("No video fragments found in level playlist");
        }

        logger.info(`Found ${videoFragments.length} video fragments`);

        const indexedVideoFragments = videoFragments.map((frag, idx) => ({
          ...frag,
          index: idx,
        }));

        this.videoLength = indexedVideoFragments.length;

        await this.downloadAllFragments(
          indexedVideoFragments,
          this.downloadId,
          stateId,
        );
      }

      throwIfAborted(this.abortSignal);

      // Process audio playlist
      if (audioPlaylistUrl) {
        if (!audioPlaylistText) {
          audioPlaylistText = this.abortSignal
            ? await cancelIfAborted(
                fetchText(audioPlaylistUrl, 3, this.abortSignal),
                this.abortSignal,
              )
            : await fetchText(audioPlaylistUrl);
          canDownloadHLSManifest(audioPlaylistText);
        }

        const audioFragments = parseLevelsPlaylist(
          audioPlaylistText,
          audioPlaylistUrl,
        );

        if (audioFragments.length === 0) {
          throw new Error("No audio fragments found in level playlist");
        }

        logger.info(`Found ${audioFragments.length} audio fragments`);

        const indexedAudioFragments = audioFragments.map((frag, idx) => ({
          ...frag,
          index: this.videoLength + idx,
        }));

        this.audioLength = indexedAudioFragments.length;

        await this.downloadAllFragments(
          indexedAudioFragments,
          this.downloadId,
          stateId,
        );
      }

      throwIfAborted(this.abortSignal);

      await this.updateStage(stateId, DownloadStage.MERGING, "Merging streams...");

      const sanitizedFilename = sanitizeFilename(filename);
      logger.info(`Sanitized filename: "${sanitizedFilename}"`);
      const baseFileName = this.sanitizeBaseFilename(filename);

      const blobUrl = await processWithFFmpeg({
        requestType: MessageType.OFFSCREEN_PROCESS_HLS,
        responseType: MessageType.OFFSCREEN_PROCESS_HLS_RESPONSE,
        downloadId: this.downloadId,
        payload: { videoLength: this.videoLength, audioLength: this.audioLength },
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

      const finalFilename = `${baseFileName}.mp4`;
      const filePath = await saveBlobUrlToFile(
        blobUrl,
        finalFilename,
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

      logger.info(`HLS download completed: ${filePath}`);

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

            const effectiveVideoLength = Math.min(chunkCount, this.videoLength);
            const effectiveAudioLength = Math.max(
              0,
              chunkCount - this.videoLength,
            );
            this.videoLength = effectiveVideoLength;
            this.audioLength = effectiveAudioLength;

            this.abortSignal = undefined;

            const baseFileName = this.sanitizeBaseFilename(filename);

            const blobUrl = await processWithFFmpeg({
              requestType: MessageType.OFFSCREEN_PROCESS_HLS,
              responseType: MessageType.OFFSCREEN_PROCESS_HLS_RESPONSE,
              downloadId: this.downloadId,
              payload: { videoLength: this.videoLength, audioLength: this.audioLength },
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

            logger.info(`HLS partial download saved: ${filePath}`);
            return { filePath, fileExtension: "mp4" };
          }
        } catch (saveError) {
          logger.error("Failed to save partial HLS download:", saveError);
        }
      }
      logger.error("HLS download failed:", error);
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
