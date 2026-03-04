/**
 * HLS live recording handler
 *
 * Polls a live HLS manifest at a fixed interval, collects new segments as they
 * appear, stores them in IndexedDB, and — when the user stops recording (or when
 * #EXT-X-ENDLIST is detected) — hands off to the existing M3U8/FFmpeg merge path
 * to produce an MP4 file.
 *
 * Extends BaseRecordingHandler for the shared polling/recording orchestration.
 * Implements the HLS-specific abstract methods: resolveMediaUrl, fetchNewSegments,
 * and buildFfmpegOptions.
 */

import { Fragment } from "../../types";
import { fetchText, fetchTextWithFinalUrl } from "../../utils/fetch-utils";
import {
  parseMasterPlaylist,
  parseMediaPlaylist,
  parseLevelsPlaylist,
} from "../../parsers/m3u8-parser";
import { logger } from "../../utils/logger";
import { MessageType } from "../../../shared/messages";
import { BaseRecordingHandler } from "../base-recording-handler";
import { DEFAULT_HLS_POLL_INTERVAL_MS } from "../../../shared/constants";

export class HlsRecordingHandler extends BaseRecordingHandler {
  /**
   * Resolve the media playlist URL from a master or media playlist URL.
   * If the URL points to a master playlist, selects the highest-bandwidth variant.
   * Returns mediaUrl (URL to poll) and finalUrl (post-redirect URL for DNR header rules).
   */
  protected async resolveMediaUrl(
    url: string,
    abortSignal: AbortSignal,
  ): Promise<{ mediaUrl: string; finalUrl: string }> {
    const { text, finalUrl: masterFinalUrl } = await fetchTextWithFinalUrl(url, this.maxRetries, abortSignal, undefined, this.retryDelayMs, this.retryBackoffFactor);

    if (!text.includes("#EXT-X-STREAM-INF")) {
      logger.info(
        `[REC] URL is already a media playlist: ${url.substring(0, 100)}...`,
      );
      return { mediaUrl: url, finalUrl: masterFinalUrl };
    }

    // Use masterFinalUrl for relative URI resolution in case of redirect
    const levels = parseMasterPlaylist(text, masterFinalUrl);
    const videoLevels = levels.filter((l) => l.type === "stream");
    if (videoLevels.length === 0) {
      logger.warn(
        `[REC] No video levels found in master playlist, using URL as-is`,
      );
      return { mediaUrl: url, finalUrl: masterFinalUrl };
    }

    videoLevels.sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
    const resolvedUrl = videoLevels[0]!.uri;
    logger.info(
      `[REC] Resolved media playlist: ${resolvedUrl.substring(0, 100)}...`,
    );
    // finalUrl for segments is the media playlist URL itself
    return { mediaUrl: resolvedUrl, finalUrl: resolvedUrl };
  }

  /**
   * Fetch the media playlist and return new segments not yet seen.
   */
  protected async fetchNewSegments(
    url: string,
    abortSignal: AbortSignal,
    seenUris: Set<string>,
  ): Promise<{ fragments: Fragment[]; pollIntervalMs: number; ended: boolean }> {
    const playlistText = await fetchText(url, this.maxRetries, abortSignal, true, undefined, this.retryDelayMs, this.retryBackoffFactor);

    const allFragments = parseLevelsPlaylist(parseMediaPlaylist(playlistText, url));
    const newFragments = allFragments.filter((f) => !seenUris.has(f.uri));

    const ended = playlistText.includes("#EXT-X-ENDLIST");
    const pollIntervalMs = this.computePollInterval(playlistText);

    return { fragments: newFragments, pollIntervalMs, ended };
  }

  /**
   * Compute HLS poll interval from #EXT-X-TARGETDURATION using configured fraction and clamps.
   */
  private computePollInterval(playlistText: string): number {
    const match = playlistText.match(/#EXT-X-TARGETDURATION:\s*(\d+(?:\.\d+)?)/);
    if (!match) return DEFAULT_HLS_POLL_INTERVAL_MS;
    const targetDuration = parseFloat(match[1]!) * 1000;
    const interval = Math.round(targetDuration * this.pollFraction);
    return Math.max(this.minPollIntervalMs, Math.min(interval, this.maxPollIntervalMs));
  }

  /**
   * FFmpeg options for merging HLS recording segments (MPEG-TS → MP4).
   */
  protected buildFfmpegOptions() {
    return {
      requestType: MessageType.OFFSCREEN_PROCESS_M3U8,
      responseType: MessageType.OFFSCREEN_PROCESS_M3U8_RESPONSE,
      payload: { fragmentCount: this.segmentIndex } as Record<string, unknown>,
    };
  }
}
