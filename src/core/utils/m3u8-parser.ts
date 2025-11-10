/**
 * M3U8 playlist parser utility
 */

import { Parser } from 'm3u8-parser';
import { buildAbsoluteURL } from 'url-toolkit';
import { v4 as uuidv4 } from 'uuid';
import { Fragment, Level, LevelType } from '../types';

/**
 * Parse a level playlist into fragments
 */
export function parseLevelsPlaylist(
  playlistText: string,
  baseUrl: string
): Fragment[] {
  const parser = new Parser();
  parser.push(playlistText);
  parser.end();

  const segments = parser.manifest.segments || [];
  const fragments: Fragment[] = [];

  let index = 0;
  let currentMapUri: string | null = null;
  let currentMapByteRange: string | null = null;

  segments.forEach((segment) => {
    // Handle initialization segments (EXT-X-MAP)
    if (segment.map && segment.map.uri) {
      const mapUri = buildAbsoluteURL(baseUrl, segment.map.uri);
      const mapByteRange = segment.map.byterange
        ? `${segment.map.byterange.offset}:${segment.map.byterange.length}`
        : null;

      // Only add map if it's different from the current one
      if (mapUri !== currentMapUri || mapByteRange !== currentMapByteRange) {
        fragments.push({
          index,
          key:
            segment.key && segment.key.uri
              ? {
                  iv: segment.key.iv
                    ? Array.from(segment.key.iv)
                        .map((b) => b.toString(16).padStart(2, '0'))
                        .join('')
                    : null,
                  uri: buildAbsoluteURL(baseUrl, segment.key.uri),
                }
              : { iv: null, uri: null },
          uri: mapUri,
        });
        index++;
        currentMapUri = mapUri;
        currentMapByteRange = mapByteRange;
      }
    }

    // Add the segment fragment
    fragments.push({
      index,
      key:
        segment.key && segment.key.uri
          ? {
              iv: segment.key.iv
                ? Array.from(segment.key.iv)
                    .map((b) => b.toString(16).padStart(2, '0'))
                    .join('')
                : null,
              uri: buildAbsoluteURL(baseUrl, segment.key.uri),
            }
          : { iv: null, uri: null },
      uri: buildAbsoluteURL(baseUrl, segment.uri),
    });
    index++;
  });

  return fragments;
}

/**
 * Parse a master playlist into levels (variants/qualities)
 */
export function parseMasterPlaylist(
  playlistText: string,
  baseUrl: string
): Level[] {
  const parser = new Parser();
  parser.push(playlistText);
  parser.end();

  const playlists = parser.manifest?.playlists || [];
  const audioPlaylists = parser.manifest?.mediaGroups?.AUDIO || {};

  // Parse video stream playlists
  const streamLevels: Level[] = playlists.map((playlist) => ({
    type: 'stream' as LevelType,
    id: uuidv4(),
    playlistID: baseUrl,
    uri: buildAbsoluteURL(baseUrl, playlist.uri),
    bitrate: playlist.attributes.BANDWIDTH,
    fps: playlist.attributes['FRAME-RATE'],
    height: playlist.attributes.RESOLUTION?.height,
    width: playlist.attributes.RESOLUTION?.width,
  }));

  // Parse audio playlists
  const audioLevels: Level[] = Object.entries(audioPlaylists).flatMap(
    ([key, entries]) => {
      return Object.entries(entries).map(([label, entry]: [string, any]) => {
        return {
          type: 'audio' as LevelType,
          id: `${label}-${key}`,
          playlistID: baseUrl,
          uri: buildAbsoluteURL(baseUrl, entry.uri),
          bitrate: undefined,
          fps: undefined,
          width: undefined,
          height: undefined,
        };
      });
    }
  );

  return [...streamLevels, ...audioLevels];
}

/**
 * Check if a playlist is a master playlist (contains variants)
 */
export function isMasterPlaylist(playlistText: string): boolean {
  const parser = new Parser();
  parser.push(playlistText);
  parser.end();

  // Master playlists have playlists array or mediaGroups
  return (
    (parser.manifest.playlists && parser.manifest.playlists.length > 0) ||
    (parser.manifest.mediaGroups &&
      Object.keys(parser.manifest.mediaGroups).length > 0) ||
    false
  );
}

export const M3u8Parser = {
  parseLevelsPlaylist,
  parseMasterPlaylist,
  isMasterPlaylist,
};

