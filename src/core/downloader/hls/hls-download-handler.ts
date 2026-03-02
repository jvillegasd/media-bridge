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
import { throwIfAborted } from "../../utils/cancellation";
import { Level, DownloadStage } from "../../types";
import { logger } from "../../utils/logger";
import {
  parseMasterPlaylist,
  parseMediaPlaylist,
  parseLevelsPlaylist,
} from "../../parsers/m3u8-parser";
import { getChunkCount } from "../../database/chunks";
import { MessageType } from "../../../shared/messages";
import { processWithFFmpeg } from "../../ffmpeg/ffmpeg-bridge";
import { canDownloadHLSManifest } from "../../utils/drm-utils";
import { saveBlobUrlToFile } from "../../utils/blob-utils";
import { BasePlaylistHandler } from "../base-playlist-handler";
import { SAVING_STAGE_PERCENTAGE } from "../../../shared/constants";

/**
 * HLS download handler for master playlists
 * Supports auto quality selection or manual quality selection
 */
export class HlsDownloadHandler extends BasePlaylistHandler {
  private videoLength: number = 0;
  private audioLength: number = 0;

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
    const audioId = this.downloadId + "_a";

    const headerRuleIds = await this.tryAddHeaderRules(stateId, masterPlaylistUrl, pageUrl);

    try {
      logger.info(`Starting HLS download from ${masterPlaylistUrl}`);

      await this.updateProgress(stateId, 0, 0, "Parsing playlist...");

      let videoPlaylistUrl: string | null = null;
      let audioPlaylistUrl: string | null = null;
      let videoPlaylistText: string | null = null;
      let audioPlaylistText: string | null = null;

      const masterPlaylistText = await this.fetchTextCancellable(masterPlaylistUrl);

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
          videoPlaylistText = await this.fetchTextCancellable(videoPlaylistUrl);
          canDownloadHLSManifest(videoPlaylistText);
        }

        if (audioPlaylistUrl) {
          audioPlaylistText = await this.fetchTextCancellable(audioPlaylistUrl);
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

      const downloadJobs: Promise<void>[] = [];

      // Process video playlist
      if (videoPlaylistUrl) {
        if (!videoPlaylistText) {
          videoPlaylistText = await this.fetchTextCancellable(videoPlaylistUrl);
          canDownloadHLSManifest(videoPlaylistText);
        }

        const videoFragments = parseLevelsPlaylist(
          parseMediaPlaylist(videoPlaylistText, videoPlaylistUrl),
          0,
        );

        if (videoFragments.length === 0) {
          throw new Error("No video fragments found in level playlist");
        }

        logger.info(`Found ${videoFragments.length} video fragments`);
        this.videoLength = videoFragments.length;

        downloadJobs.push(
          this.downloadAllFragments(videoFragments, this.downloadId, stateId),
        );
      }

      // Process audio playlist
      if (audioPlaylistUrl) {
        if (!audioPlaylistText) {
          audioPlaylistText = await this.fetchTextCancellable(audioPlaylistUrl);
          canDownloadHLSManifest(audioPlaylistText);
        }

        const audioFragments = parseLevelsPlaylist(
          parseMediaPlaylist(audioPlaylistText, audioPlaylistUrl),
          0,
        );

        if (audioFragments.length === 0) {
          throw new Error("No audio fragments found in level playlist");
        }

        logger.info(`Found ${audioFragments.length} audio fragments`);
        this.audioLength = audioFragments.length;

        downloadJobs.push(
          this.downloadAllFragments(audioFragments, audioId, stateId),
        );
      }

      const results = await Promise.allSettled(downloadJobs);
      const cancelled = results.find(
        (r) => r.status === "rejected" && r.reason instanceof CancellationError,
      );
      if (cancelled) throw new CancellationError();
      const failed = results.find((r) => r.status === "rejected");
      if (failed) throw (failed as PromiseRejectedResult).reason;

      await this.updateStage(stateId, DownloadStage.MERGING, "Merging streams...");

      const baseFileName = this.sanitizeBaseFilename(filename);

      const { blobUrl, warning } = await processWithFFmpeg({
        requestType: MessageType.OFFSCREEN_PROCESS_HLS,
        responseType: MessageType.OFFSCREEN_PROCESS_HLS_RESPONSE,
        downloadId: this.downloadId,
        payload: {
          videoLength: this.videoLength,
          audioLength: this.audioLength,
          audioDownloadId: this.audioLength > 0 ? audioId : undefined,
        },
        filename: baseFileName,
        timeout: this.ffmpegTimeout,
        abortSignal: this.abortSignal,
        onProgress: this.createMergingProgressCallback(stateId),
      });

      await this.updateStage(stateId, DownloadStage.SAVING, "Saving file...", SAVING_STAGE_PERCENTAGE);

      const finalFilename = `${baseFileName}.mp4`;
      const filePath = await saveBlobUrlToFile(
        blobUrl,
        finalFilename,
        stateId,
      );

      const completionMessage = warning
        ? `Download completed — ${warning}`
        : "Download completed";
      await this.markCompleted(stateId, filePath, completionMessage);

      logger.info(`HLS download completed: ${filePath}`);

      return {
        filePath,
        fileExtension: "mp4",
      };
    } catch (error) {
      if (error instanceof CancellationError && this.shouldSaveOnCancel?.()) {
        try {
          const videoChunkCount = await getChunkCount(this.downloadId);
          const audioChunkCount = this.audioLength > 0 ? await getChunkCount(audioId) : 0;
          const effectiveVideoLength = Math.min(videoChunkCount, this.videoLength);
          const effectiveAudioLength = Math.min(audioChunkCount, this.audioLength);
          this.videoLength = effectiveVideoLength;
          this.audioLength = effectiveAudioLength;

          const result = await this.savePartialDownload(stateId, filename, {
            requestType: MessageType.OFFSCREEN_PROCESS_HLS,
            responseType: MessageType.OFFSCREEN_PROCESS_HLS_RESPONSE,
            payload: {
              videoLength: this.videoLength,
              audioLength: this.audioLength,
              audioDownloadId: this.audioLength > 0 ? audioId : undefined,
            },
          });
          logger.info(`HLS partial download saved: ${result.filePath}`);
          return result;
        } catch (saveError) {
          if (saveError instanceof CancellationError) {
            // No chunks to save — fall through to throw original error
          } else {
            logger.error("Failed to save partial HLS download:", saveError);
          }
        }
      }
      logger.error("HLS download failed:", error);
      throw error;
    } finally {
      await this.tryRemoveHeaderRules(headerRuleIds);
      await this.cleanupChunks(this.downloadId || stateId);
      await this.cleanupChunks((this.downloadId || stateId) + "_a");
    }
  }
}
