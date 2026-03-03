/**
 * DASH VOD download handler
 *
 * Downloads static MPEG-DASH streams by parsing the MPD manifest, downloading
 * video and audio segments (with init segments), and merging them into an MP4
 * via the offscreen FFmpeg worker.
 *
 * Extends BasePlaylistHandler for shared download/progress/cleanup logic.
 * Key differences from HlsDownloadHandler:
 *   - Uses mpd-parser instead of m3u8-parser
 *   - Handles ISOBMF (.m4s) segments — no MPEG-TS bitstream filter needed
 *   - Uses OFFSCREEN_PROCESS_DASH message type
 */

import { CancellationError } from "../../utils/errors";
import { throwIfAborted } from "../../utils/cancellation";
import { DownloadStage } from "../../types";
import { logger } from "../../utils/logger";
import { getChunkCount } from "../../database/chunks";
import { MessageType } from "../../../shared/messages";
import { processWithFFmpeg } from "../../ffmpeg/ffmpeg-bridge";
import { saveBlobUrlToFile } from "../../utils/blob-utils";
import { BasePlaylistHandler } from "../base-playlist-handler";
import { SAVING_STAGE_PERCENTAGE } from "../../../shared/constants";
import { DownloadError } from "../../utils/errors";
import {
  parseManifest,
  parseLevelsPlaylist,
  hasDrm,
  getVideoPlaylist,
  getVideoPlaylistByBandwidth,
  getAudioPlaylist,
} from "../../parsers/mpd-parser";

export class DashDownloadHandler extends BasePlaylistHandler {
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

  /**
   * Download a static DASH stream from the given MPD URL.
   */
  async download(
    mpdUrl: string,
    filename: string,
    stateId: string,
    abortSignal?: AbortSignal,
    pageUrl?: string,
    selectedBandwidth?: number,
  ): Promise<{ filePath: string; fileExtension?: string }> {
    this.resetDownloadState(stateId, abortSignal);
    const audioId = this.downloadId + "_a";

    const headerRuleIds = await this.tryAddHeaderRules(stateId, mpdUrl, pageUrl);

    try {
      logger.info(`Starting DASH download from ${mpdUrl}`);

      await this.updateProgress(stateId, 0, 0, "Parsing MPD manifest...");

      const mpdText = await this.fetchTextCancellable(mpdUrl);

      if (hasDrm(mpdText)) {
        throw new DownloadError("Cannot download DRM-protected DASH content");
      }

      const manifest = parseManifest(mpdText, mpdUrl);

      const videoPlaylist = selectedBandwidth
        ? getVideoPlaylistByBandwidth(manifest, selectedBandwidth)
        : getVideoPlaylist(manifest);
      if (!videoPlaylist) {
        throw new Error("No video streams found in MPD manifest");
      }

      const audioPlaylist = getAudioPlaylist(manifest);

      throwIfAborted(this.abortSignal);

      // Download video stream (init at index 0, media at 1..N)
      const videoFragments = parseLevelsPlaylist(videoPlaylist, 0);
      if (videoFragments.length === 0) {
        throw new Error("No video segments found in MPD manifest");
      }
      logger.info(`Found ${videoFragments.length} DASH video fragments`);
      this.videoLength = videoFragments.length;

      const downloadJobs: Promise<void>[] = [
        this.downloadAllFragments(videoFragments, this.downloadId, stateId),
      ];

      // Download audio stream concurrently if present (separate namespace)
      this.audioLength = 0;
      if (audioPlaylist) {
        const audioFragments = parseLevelsPlaylist(audioPlaylist, 0);
        logger.info(`Found ${audioFragments.length} DASH audio fragments`);
        this.audioLength = audioFragments.length;
        downloadJobs.push(this.downloadAllFragments(audioFragments, audioId, stateId));
      }

      const results = await Promise.allSettled(downloadJobs);
      const cancelled = results.find(
        (r) => r.status === "rejected" && r.reason instanceof CancellationError,
      );
      if (cancelled) throw new CancellationError();
      const failed = results.find((r) => r.status === "rejected");
      if (failed) throw (failed as PromiseRejectedResult).reason;

      await this.updateStage(
        stateId,
        DownloadStage.MERGING,
        "Merging DASH streams...",
      );

      const baseFileName = this.sanitizeBaseFilename(filename);

      const { blobUrl, warning } = await processWithFFmpeg({
        requestType: MessageType.OFFSCREEN_PROCESS_DASH,
        responseType: MessageType.OFFSCREEN_PROCESS_DASH_RESPONSE,
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
      );

      const completionMessage = warning
        ? `Download completed — ${warning}`
        : "Download completed";
      await this.markCompleted(stateId, filePath, completionMessage);

      logger.info(`DASH download completed: ${filePath}`);
      return { filePath, fileExtension: "mp4" };
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
            requestType: MessageType.OFFSCREEN_PROCESS_DASH,
            responseType: MessageType.OFFSCREEN_PROCESS_DASH_RESPONSE,
            payload: {
              videoLength: this.videoLength,
              audioLength: this.audioLength,
              audioDownloadId: this.audioLength > 0 ? audioId : undefined,
            },
          });
          logger.info(`DASH partial download saved: ${result.filePath}`);
          return result;
        } catch (saveError) {
          if (!(saveError instanceof CancellationError)) {
            logger.error("Failed to save partial DASH download:", saveError);
          }
        }
      }
      logger.error("DASH download failed:", error);
      throw error;
    } finally {
      await this.tryRemoveHeaderRules(headerRuleIds);
      await this.cleanupChunks(this.downloadId || stateId);
      await this.cleanupChunks((this.downloadId || stateId) + "_a");
    }
  }
}
