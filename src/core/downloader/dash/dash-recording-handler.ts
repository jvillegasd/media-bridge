/**
 * DASH live recording handler
 *
 * Polls a live DASH MPD at a fixed interval, collects new segments as they
 * appear (single video stream, audio muxed), and — when the user stops
 * recording or the stream transitions to `type="static"` — merges and saves.
 *
 * Extends BaseRecordingHandler for the shared polling/recording orchestration.
 * Uses a single-track approach: init segment at index 0, media segments at 1..N.
 */

import { Fragment } from "../../types";
import { fetchText } from "../../utils/fetch-utils";
import { logger } from "../../utils/logger";
import { MessageType } from "../../../shared/messages";
import { BaseRecordingHandler } from "../base-recording-handler";
import {
  parseManifest,
  parseLevelsPlaylist,
  isLive,
  getPollIntervalMs,
  MpdPlaylist,
} from "../../utils/mpd-parser";

export class DashRecordingHandler extends BaseRecordingHandler {
  /**
   * DASH recordings poll the MPD URL itself — no separate media playlist URL.
   */
  protected async resolveMediaUrl(url: string, _abortSignal: AbortSignal): Promise<string> {
    return url;
  }

  /**
   * Fetch and re-parse the MPD, returning new segments not yet seen.
   */
  protected async fetchNewSegments(
    mpdUrl: string,
    abortSignal: AbortSignal,
    seenUris: Set<string>,
  ): Promise<{ fragments: Fragment[]; pollIntervalMs: number; ended: boolean }> {
    const mpdText = await fetchText(mpdUrl, 3, abortSignal, true);

    const manifest = parseManifest(mpdText, mpdUrl);

    // Select highest bandwidth video playlist (single stream — audio typically muxed)
    const playlists: MpdPlaylist[] = [...(manifest.playlists || [])];
    if (playlists.length === 0) {
      return { fragments: [], pollIntervalMs: getPollIntervalMs(mpdText), ended: false };
    }
    playlists.sort(
      (a, b) => (b.attributes?.BANDWIDTH || 0) - (a.attributes?.BANDWIDTH || 0),
    );
    const playlist = playlists[0]!;

    // Parse all segments for this playlist and filter to only new ones
    const allFragments = parseLevelsPlaylist(playlist, 0);
    const newFragments = allFragments.filter((f) => !seenUris.has(f.uri));

    // Stream ended when manifest switches from dynamic to static
    const ended = !isLive(mpdText);
    const pollIntervalMs = getPollIntervalMs(mpdText);

    logger.info(
      `[DASH REC] manifest segments=${allFragments.length}, new=${newFragments.length}, ended=${ended}`,
    );

    return { fragments: newFragments, pollIntervalMs, ended };
  }

  /**
   * FFmpeg options for merging DASH recording segments (ISOBMF → MP4).
   */
  protected buildFfmpegOptions() {
    return {
      requestType: MessageType.OFFSCREEN_PROCESS_DASH,
      responseType: MessageType.OFFSCREEN_PROCESS_DASH_RESPONSE,
      payload: { fragmentCount: this.segmentIndex } as Record<string, unknown>,
    };
  }
}
