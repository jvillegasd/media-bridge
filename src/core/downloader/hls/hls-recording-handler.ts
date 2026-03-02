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
import { fetchText } from "../../utils/fetch-utils";
import {
  parseMasterPlaylist,
  parseMediaPlaylist,
  parseLevelsPlaylist,
} from "../../parsers/m3u8-parser";
import { logger } from "../../utils/logger";
import { MessageType } from "../../../shared/messages";
import { BaseRecordingHandler } from "../base-recording-handler";

const DEFAULT_POLL_INTERVAL_MS = 3000;
const MIN_POLL_INTERVAL_MS = 1000;
const MAX_POLL_INTERVAL_MS = 10000;
const POLL_INTERVAL_FRACTION = 0.5;

/**
 * Extract #EXT-X-TARGETDURATION from playlist text and compute a poll interval.
 * Polls at half the target duration to avoid missing segments.
 */
function computePollInterval(playlistText: string): number {
  const match = playlistText.match(/#EXT-X-TARGETDURATION:\s*(\d+(?:\.\d+)?)/);
  if (!match) return DEFAULT_POLL_INTERVAL_MS;
  const targetDuration = parseFloat(match[1]!) * 1000;
  const interval = Math.round(targetDuration * POLL_INTERVAL_FRACTION);
  return Math.max(MIN_POLL_INTERVAL_MS, Math.min(interval, MAX_POLL_INTERVAL_MS));
}

export class HlsRecordingHandler extends BaseRecordingHandler {
  /**
   * Resolve the media playlist URL from a master or media playlist URL.
   * If the URL points to a master playlist, selects the highest-bandwidth variant.
   */
  protected async resolveMediaUrl(
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

  /**
   * Fetch the media playlist and return new segments not yet seen.
   */
  protected async fetchNewSegments(
    url: string,
    abortSignal: AbortSignal,
    seenUris: Set<string>,
  ): Promise<{ fragments: Fragment[]; pollIntervalMs: number; ended: boolean }> {
    const playlistText = await fetchText(url, 3, abortSignal, true);

    const allFragments = parseLevelsPlaylist(parseMediaPlaylist(playlistText, url));
    const newFragments = allFragments.filter((f) => !seenUris.has(f.uri));

    const ended = playlistText.includes("#EXT-X-ENDLIST");
    const pollIntervalMs = computePollInterval(playlistText);

    return { fragments: newFragments, pollIntervalMs, ended };
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
