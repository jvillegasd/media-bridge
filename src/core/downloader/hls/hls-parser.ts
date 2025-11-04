/**
 * HLS playlist parser
 */

import { Parser, type Segment, type PlaylistItem } from 'm3u8-parser';
import { buildAbsoluteURL } from 'url-toolkit';
import { v4 as uuidv4 } from 'uuid';

export interface HlsKey {
  uri: string | null;
  iv: Uint8Array | null;
}

export interface HlsFragment {
  index: number;
  key: HlsKey;
  uri: string;
}

export interface HlsLevel {
  type: 'stream' | 'audio';
  id: string;
  playlistID: string;
  uri: string;
  bitrate?: number;
  fps?: number;
  height?: number;
  width?: number;
}

export class HlsParser {
  /**
   * Parse master playlist to get available quality levels
   */
  static parseMasterPlaylist(playlistText: string, baseUrl: string): HlsLevel[] {
    const parser = new Parser();
    parser.push(playlistText);

    const playlists = parser.manifest?.playlists ?? [];
    const audioPlaylists = parser.manifest?.mediaGroups?.AUDIO ?? {};

    // Parse video stream playlists
    const videoLevels: HlsLevel[] = (playlists as PlaylistItem[]).map((playlist) => ({
      type: 'stream' as const,
      id: uuidv4(),
      playlistID: baseUrl,
      uri: buildAbsoluteURL(baseUrl, playlist.uri),
      bitrate: playlist.attributes.BANDWIDTH,
      fps: playlist.attributes['FRAME-RATE'],
      height: playlist.attributes.RESOLUTION?.height,
      width: playlist.attributes.RESOLUTION?.width,
    }));

    // Parse audio playlists
    const audioLevels: HlsLevel[] = Object.entries(audioPlaylists as Record<string, Record<string, { uri?: string }>>).flatMap(
      ([key, entries]) => {
        return Object.entries(entries).map(([label, entry]) => ({
          type: 'audio' as const,
          id: `${label}-${key}`,
          playlistID: baseUrl,
          uri: buildAbsoluteURL(baseUrl, entry.uri || ''),
          bitrate: undefined,
          fps: undefined,
          width: undefined,
          height: undefined,
        }));
      }
    );

    return [...videoLevels, ...audioLevels];
  }

  /**
   * Parse level playlist to get all fragments/segments
   */
  static parseLevelPlaylist(playlistText: string, baseUrl: string): HlsFragment[] {
    const parser = new Parser();
    parser.push(playlistText);

    const segments = parser.manifest.segments;
    const fragments: HlsFragment[] = [];

    let index = 0;
    let currentMapUri: string | null = null;
    let currentMapByteRange: string | null = null;

    segments.forEach((segment: Segment) => {
      // Handle initialization segments (EXT-X-MAP)
      if (segment.map && segment.map.uri) {
        const mapUri = buildAbsoluteURL(baseUrl, segment.map.uri);
        const mapByteRange = segment.map.byterange
          ? `${segment.map.byterange.offset}:${segment.map.byterange.length}`
          : null;

        // Only add if different from previous
        if (mapUri !== currentMapUri || mapByteRange !== currentMapByteRange) {
          fragments.push({
            index,
            key: this.extractKey(segment, baseUrl),
            uri: mapUri,
          });
          index++;
          currentMapUri = mapUri;
          currentMapByteRange = mapByteRange;
        }
      }

      // Add the segment itself
      fragments.push({
        index,
        key: this.extractKey(segment, baseUrl),
        uri: buildAbsoluteURL(baseUrl, segment.uri),
      });
      index++;
    });

    return fragments;
  }

  /**
   * Extract encryption key from segment
   */
  private static extractKey(segment: Segment, baseUrl: string): HlsKey {
    if (segment.key && segment.key.uri) {
      // Convert Uint32Array to Uint8Array if needed
      let iv: Uint8Array | null = null;
      if (segment.key.iv) {
        // IV from parser is Uint32Array, but we need Uint8Array
        const iv32 = segment.key.iv;
        iv = new Uint8Array(iv32.buffer, iv32.byteOffset, iv32.byteLength);
      }
      return {
        iv,
        uri: buildAbsoluteURL(baseUrl, segment.key.uri),
      };
    }
    return { iv: null, uri: null };
  }
}

