/**
 * MPD (MPEG-DASH) manifest parser utility
 *
 * Wraps the `mpd-parser` npm package and converts its output to the
 * project's Fragment[] and Level[] types. Mirrors the structure of m3u8-parser.ts.
 */

import { parse, MpdManifest, MpdPlaylist } from "mpd-parser";
import { v4 as uuidv4 } from "uuid";
import { Level, LevelType } from "../types";
import type { ParsedPlaylist, ParsedSegment } from "./playlist-utils";
import { parseLevelsPlaylist } from "./playlist-utils";

// Re-export for callers that want the unified Fragment conversion.
export { parseLevelsPlaylist } from "./playlist-utils";

export type { MpdManifest } from "mpd-parser";

/**
 * Convert an mpd-parser MpdPlaylist into a ParsedPlaylist.
 */
function mpdPlaylistToParsedPlaylist(playlist: MpdPlaylist): ParsedPlaylist {
  const segments: ParsedSegment[] = (playlist.segments || []).map((segment) => ({
    uri: segment.resolvedUri || segment.uri,
    ...(segment.map ? { initUri: segment.map.resolvedUri || segment.map.uri } : {}),
  }));
  return { segments };
}

/**
 * Parse an MPD manifest string into a structured manifest object.
 */
export function parseManifest(mpdText: string, mpdUrl: string): MpdManifest {
  return parse(mpdText, { manifestUri: mpdUrl }) as MpdManifest;
}

/**
 * Parse an MPD manifest into Level[] (one Level per representation).
 * Mirrors parseMasterPlaylist() from m3u8-parser.ts.
 */
export function parseMasterPlaylist(mpdText: string, mpdUrl: string): Level[] {
  const manifest = parseManifest(mpdText, mpdUrl);
  return (manifest.playlists || []).map((playlist) => ({
    type: "stream" as LevelType,
    id: uuidv4(),
    playlistID: mpdUrl,
    uri: mpdUrl, // DASH representations all derive from the same MPD URL
    bitrate: playlist.attributes?.BANDWIDTH,
    height: playlist.attributes?.RESOLUTION?.height,
    width: playlist.attributes?.RESOLUTION?.width,
  }));
}

/**
 * Select the highest-bandwidth video playlist from a parsed MPD manifest
 * and return it as a ParsedPlaylist, ready for parseLevelsPlaylist().
 * Returns null if no video playlists are present.
 */
export function getVideoPlaylist(manifest: MpdManifest): ParsedPlaylist | null {
  const playlists = [...(manifest.playlists || [])];
  if (!playlists.length) return null;
  playlists.sort((a, b) => (b.attributes?.BANDWIDTH || 0) - (a.attributes?.BANDWIDTH || 0));
  return mpdPlaylistToParsedPlaylist(playlists[0]!);
}

/**
 * Extract the first audio playlist from the parsed manifest's mediaGroups
 * and return it as a ParsedPlaylist, ready for parseLevelsPlaylist().
 * Returns null if no audio adaptation set is present.
 */
export function getAudioPlaylist(manifest: MpdManifest): ParsedPlaylist | null {
  const audioGroup = manifest.mediaGroups?.AUDIO?.audio;
  if (!audioGroup) return null;
  for (const group of Object.values(audioGroup)) {
    if (group.playlists?.length) {
      return mpdPlaylistToParsedPlaylist(group.playlists[0]!);
    }
  }
  return null;
}

/**
 * Detect whether an MPD describes a live (dynamic) stream.
 * Checks for `type="dynamic"` in the raw XML — more reliable than inspecting
 * the parsed output, which always sets minimumUpdatePeriod.
 */
export function isLive(mpdText: string): boolean {
  return /type\s*=\s*["']dynamic["']/i.test(mpdText);
}

/**
 * Check whether an MPD contains DRM (ContentProtection elements).
 */
export function hasDrm(mpdText: string): boolean {
  return /<ContentProtection/i.test(mpdText) || /cenc:/i.test(mpdText);
}

/**
 * Extract the poll interval from minimumUpdatePeriod in the MPD.
 * Clamped to [1000ms, 10000ms]; defaults to 3000ms if not present.
 */
export function getPollIntervalMs(mpdText: string): number {
  const match = mpdText.match(/minimumUpdatePeriod\s*=\s*["']PT([\d.]+)S["']/i);
  if (!match) return 3000;
  const seconds = parseFloat(match[1]!);
  const ms = Math.round(seconds * 1000);
  return Math.max(1000, Math.min(ms, 10000));
}

export const MpdParser = {
  parseManifest,
  parseMasterPlaylist,
  parseLevelsPlaylist,
  getVideoPlaylist,
  getAudioPlaylist,
  isLive,
  hasDrm,
  getPollIntervalMs,
};
