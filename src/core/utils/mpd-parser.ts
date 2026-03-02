/**
 * MPD (MPEG-DASH) manifest parser utility
 *
 * Wraps the `mpd-parser` npm package and converts its output to the
 * project's Fragment[] and Level[] types. Mirrors the structure of m3u8-parser.ts.
 */

import { parse } from "mpd-parser";
import { v4 as uuidv4 } from "uuid";
import { Fragment, Level, LevelType } from "../types";

// Typed shapes for mpd-parser output (no bundled @types, so we define what we need)
export interface MpdSegment {
  uri: string;
  resolvedUri: string;
  duration: number;
  map?: {
    uri: string;
    resolvedUri: string;
    byterange?: { offset: number | bigint; length: number | bigint };
  };
}

export interface MpdPlaylist {
  uri: string;
  attributes: {
    BANDWIDTH?: number;
    RESOLUTION?: { width: number; height: number };
    CODECS?: string;
    [key: string]: unknown;
  };
  segments: MpdSegment[];
  contentProtection?: Record<string, unknown>;
}

export interface MpdManifest {
  playlists: MpdPlaylist[];
  mediaGroups: {
    AUDIO?: {
      audio?: Record<string, { playlists?: MpdPlaylist[] }>;
    };
  };
  minimumUpdatePeriod?: number; // in ms; always present in mpd-parser output
  [key: string]: unknown;
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
 * Parse a single representation's segments into Fragment[].
 *
 * Handles the init segment (segment.map) the same way m3u8-parser handles
 * EXT-X-MAP: inserts it as a Fragment at the current index, deduplicated by URI.
 * Indices are assigned sequentially from `startIndex`.
 * Mirrors parseLevelsPlaylist() from m3u8-parser.ts.
 */
export function parseLevelsPlaylist(
  playlist: MpdPlaylist,
  startIndex: number = 0,
): Fragment[] {
  const fragments: Fragment[] = [];
  const segments = playlist.segments || [];
  let index = startIndex;
  let currentMapUri: string | null = null;

  for (const segment of segments) {
    // Handle init segment (like EXT-X-MAP) — deduplicate by URI
    if (segment.map) {
      const mapUri = segment.map.resolvedUri || segment.map.uri;
      if (mapUri && mapUri !== currentMapUri) {
        fragments.push({
          index,
          key: { iv: null, uri: null },
          uri: mapUri,
        });
        index++;
        currentMapUri = mapUri;
      }
    }

    const segUri = segment.resolvedUri || segment.uri;
    fragments.push({
      index,
      key: { iv: null, uri: null },
      uri: segUri,
    });
    index++;
  }

  return fragments;
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

/**
 * Extract the first audio playlist from the parsed manifest's mediaGroups.
 * Returns null if no audio adaptation set is present.
 */
export function getAudioPlaylist(manifest: MpdManifest): MpdPlaylist | null {
  const audioGroup = manifest.mediaGroups?.AUDIO?.audio;
  if (!audioGroup) return null;
  for (const group of Object.values(audioGroup)) {
    if (group.playlists?.length) {
      return group.playlists[0]!;
    }
  }
  return null;
}

export const MpdParser = {
  parseManifest,
  parseMasterPlaylist,
  parseLevelsPlaylist,
  isLive,
  hasDrm,
  getPollIntervalMs,
  getAudioPlaylist,
};
