/**
 * M3U8 playlist parser utility
 */

import { Parser } from 'm3u8-parser';
import { buildAbsoluteURL } from 'url-toolkit';
import { v4 as uuidv4 } from 'uuid';
import { Fragment, Level, LevelType } from '../types';
import { normalizeUrl } from './url-utils';
import { logger } from './logger';

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

/**
 * Check if a playlist is a media playlist (contains direct segments)
 */
export function isMediaPlaylist(playlistText: string): boolean {
  const parser = new Parser();
  parser.push(playlistText);
  parser.end();

  // Media playlists have segments array with actual segment URIs
  // They don't have playlists or mediaGroups (those are master playlists)
  const hasSegments = parser.manifest.segments && parser.manifest.segments.length > 0;
  const hasNoPlaylists = !parser.manifest.playlists || parser.manifest.playlists.length === 0;
  const hasNoMediaGroups = !parser.manifest.mediaGroups || Object.keys(parser.manifest.mediaGroups).length === 0;

  return hasSegments && hasNoPlaylists && hasNoMediaGroups;
}

/**
 * Check if a media playlist belongs to a specific master playlist
 * 
 * This function determines membership by comparing URLs:
 * 1. Parses the master playlist to extract all variant URIs
 * 2. Resolves variant URIs into full URLs (relative to master playlist base URL)
 * 3. Compares the media playlist URL against all variant URLs
 * 4. Returns true if there's a match
 * 
 * @param masterPlaylistText - The master playlist content as text
 * @param masterPlaylistBaseUrl - The base URL of the master playlist (used to resolve relative URIs)
 * @param mediaPlaylistUrl - The URL of the media playlist to check
 * @returns true if the media playlist belongs to the master playlist, false otherwise
 */
export function belongsToMasterPlaylist(
  masterPlaylistText: string,
  masterPlaylistBaseUrl: string,
  mediaPlaylistUrl: string
): boolean {
  // Parse the master playlist to get all variant levels
  const levels = parseMasterPlaylist(masterPlaylistText, masterPlaylistBaseUrl);
  
  // Normalize the media playlist URL for comparison
  const normalizedMediaUrl = normalizeUrl(mediaPlaylistUrl);
  
  logger.info("normalizedMediaUrl", { normalizedMediaUrl });
  logger.info("levels", { levels });


  // Check if the media playlist URL matches any variant URL from the master playlist
  return levels.some((level) => {
    const normalizedVariantUrl = normalizeUrl(level.uri);
    return normalizedVariantUrl === normalizedMediaUrl;
  });
}

export const M3u8Parser = {
  parseLevelsPlaylist,
  parseMasterPlaylist,
  isMasterPlaylist,
  isMediaPlaylist,
  belongsToMasterPlaylist,
};

