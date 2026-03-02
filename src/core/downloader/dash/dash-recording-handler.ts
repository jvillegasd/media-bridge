/**
 * DASH live recording handler
 *
 * Polls a live DASH MPD at a fixed interval, collects new segments as they
 * appear (separate video and audio streams), and — when the user stops
 * recording or the stream transitions to `type="static"` — merges and saves.
 *
 * Extends BaseRecordingHandler for the shared polling/recording orchestration.
 * Video segments are stored under downloadId, audio under downloadId + "_a".
 */

import { Fragment } from "../../types";
import { fetchText, fetchTextWithFinalUrl } from "../../utils/fetch-utils";
import { logger } from "../../utils/logger";
import { MessageType } from "../../../shared/messages";
import { BaseRecordingHandler } from "../base-recording-handler";
import {
  parseManifest,
  parseLevelsPlaylist,
  isLive,
  getPollIntervalMs,
  getVideoPlaylist,
  getVideoPlaylistByBandwidth,
  getAudioPlaylist,
} from "../../parsers/mpd-parser";

export class DashRecordingHandler extends BaseRecordingHandler {
  private seenAudioUris: Set<string> = new Set();

  protected override resetDownloadState(
    stateId: string,
    abortSignal?: AbortSignal,
  ): void {
    super.resetDownloadState(stateId, abortSignal);
    this.seenAudioUris = new Set();
  }

  /**
   * Fetch the MPD once to capture the post-redirect URL for DNR header rules.
   * Polling continues against the original url to avoid repeated redirects.
   */
  protected async resolveMediaUrl(
    url: string,
    abortSignal: AbortSignal,
  ): Promise<{ mediaUrl: string; finalUrl: string }> {
    const { finalUrl } = await fetchTextWithFinalUrl(url, 1, abortSignal, false);
    return { mediaUrl: url, finalUrl };
  }

  /**
   * Fetch and re-parse the MPD, returning new video and audio segments not yet seen.
   */
  protected async fetchNewSegments(
    mpdUrl: string,
    abortSignal: AbortSignal,
    seenUris: Set<string>,
  ): Promise<{ fragments: Fragment[]; audioFragments?: Fragment[]; pollIntervalMs: number; ended: boolean }> {
    const mpdText = await fetchText(mpdUrl, 3, abortSignal, true);

    const manifest = parseManifest(mpdText, mpdUrl);

    // Video: select by bandwidth if specified, otherwise highest
    const videoPlaylist = this.selectedBandwidth
      ? getVideoPlaylistByBandwidth(manifest, this.selectedBandwidth)
      : getVideoPlaylist(manifest);
    const allVideoFragments = videoPlaylist ? parseLevelsPlaylist(videoPlaylist, 0) : [];
    const newVideoFragments = allVideoFragments.filter((f) => !seenUris.has(f.uri));

    // Audio: first audio adaptation set
    const audioPlaylist = getAudioPlaylist(manifest);
    let newAudioFragments: Fragment[] | undefined;
    if (audioPlaylist) {
      const allAudioFragments = parseLevelsPlaylist(audioPlaylist, 0);
      const fresh = allAudioFragments.filter((f) => !this.seenAudioUris.has(f.uri));
      if (fresh.length > 0) {
        fresh.forEach((f) => this.seenAudioUris.add(f.uri));
        newAudioFragments = fresh;
      }
    }

    // Stream ended when manifest switches from dynamic to static
    const ended = !isLive(mpdText);
    const pollIntervalMs = getPollIntervalMs(mpdText);

    logger.info(
      `[DASH REC] video new=${newVideoFragments.length}, audio new=${newAudioFragments?.length ?? 0}, ended=${ended}`,
    );

    return { fragments: newVideoFragments, audioFragments: newAudioFragments, pollIntervalMs, ended };
  }

  /**
   * Clean up video chunks and, if audio was recorded, audio chunks too.
   */
  protected override async cleanupChunks(downloadId: string): Promise<void> {
    await super.cleanupChunks(downloadId);
    if (this.audioSegmentIndex > 0) {
      await super.cleanupChunks(downloadId + "_a");
    }
  }

  /**
   * FFmpeg options for merging DASH recording segments (ISOBMF → MP4).
   * Bug 1 fix: use videoLength/audioLength keys (not fragmentCount).
   * Bug 2 fix: include audioDownloadId for the separate audio namespace.
   */
  protected buildFfmpegOptions() {
    return {
      requestType: MessageType.OFFSCREEN_PROCESS_DASH,
      responseType: MessageType.OFFSCREEN_PROCESS_DASH_RESPONSE,
      payload: {
        videoLength: this.segmentIndex,
        audioLength: this.audioSegmentIndex,
        audioDownloadId: this.audioSegmentIndex > 0 ? this.downloadId + "_a" : undefined,
      } as Record<string, unknown>,
    };
  }
}
