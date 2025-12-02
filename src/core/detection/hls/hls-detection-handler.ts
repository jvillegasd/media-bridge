/**
 * HLS detection handler - orchestrates HLS playlist detection
 *
 * This handler is responsible for detecting HLS (HTTP Live Streaming) playlists from network requests.
 * It distinguishes between master playlists (containing multiple quality variants) and media playlists
 * (containing actual video fragments), and manages the relationship between them.
 *
 * Key features:
 * - Detects HLS master playlists and media playlists from network requests
 * - Distinguishes between master and media playlists
 * - Tracks master playlists and their variant URLs
 * - Removes media playlists that belong to master playlists (to avoid duplicates)
 * - Extracts metadata from playlist URLs
 * - Handles both HLS format (master playlists) and M3U8 format (standalone media playlists)
 *
 * Detection process:
 * 1. Network requests are intercepted and checked for .m3u8 URLs
 * 2. Playlist content is fetched and analyzed to determine type (master vs media)
 * 3. Master playlists are tracked with their variant URLs
 * 4. Media playlists are checked if they belong to tracked master playlists
 * 5. Standalone media playlists are detected as M3U8 format
 * 6. Master playlists are detected as HLS format
 * 7. Variant videos are removed when master playlist is detected
 *
 * @module HlsDetectionHandler
 */

import { VideoMetadata } from "../../types";
import {
  isMasterPlaylist,
  isMediaPlaylist,
  parseMasterPlaylist,
  belongsToMasterPlaylist,
} from "../../utils/m3u8-parser";
import { fetchText } from "../../utils/fetch-utils";
import { normalizeUrl } from "../../utils/url-utils";
import { logger } from "../../utils/logger";
import { extractThumbnail } from "../../utils/thumbnail-utils";
import { hasDrm, canDecrypt } from "../../utils/drm-utils";

/** Configuration options for HlsDetectionHandler */
export interface HlsDetectionHandlerOptions {
  /** Optional callback for detected videos */
  onVideoDetected?: (video: VideoMetadata) => void;
  /** Optional callback for removed videos */
  onVideoRemoved?: (url: string) => void;
}

/** Internal structure for tracking master playlist information */
interface MasterPlaylistInfo {
  url: string;
  variantUrls: Set<string>;
  playlistText: string;
}

/**
 * HLS detection handler
 * Detects HLS master playlists and standalone media playlists
 */
export class HlsDetectionHandler {
  private onVideoDetected?: (video: VideoMetadata) => void;
  private onVideoRemoved?: (url: string) => void;
  // Track master playlists and their variants
  private masterPlaylists: Map<string, MasterPlaylistInfo> = new Map();

  /**
   * Create a new HlsDetectionHandler instance
   * @param options - Configuration options
   */
  constructor(options: HlsDetectionHandlerOptions = {}) {
    this.onVideoDetected = options.onVideoDetected;
    this.onVideoRemoved = options.onVideoRemoved;
  }

  /**
   * Detect HLS playlist from URL
   * @param url - Playlist URL to detect
   * @returns Promise resolving to VideoMetadata or null if not detected
   */
  async detect(url: string): Promise<VideoMetadata | null> {
    if (!this.isHlsUrl(url)) {
      return null;
    }

    try {
      const playlistText = await this.fetchPlaylistText(url);
      const normalizedUrl = normalizeUrl(url);
      const isMaster = isMasterPlaylist(playlistText);
      const isMedia = isMediaPlaylist(playlistText);

      if (isMedia) {
        return await this.handleMediaPlaylist(url, normalizedUrl, playlistText);
      }

      if (isMaster) {
        return await this.handleMasterPlaylist(
          url,
          normalizedUrl,
          playlistText,
        );
      }

      logger.warn(
        "[Media Bridge] HLS URL is neither master nor media playlist, skipping",
        { url },
      );
      return null;
    } catch (error) {
      logger.error("[Media Bridge] Failed to validate HLS playlist:", error);
      return null;
    }
  }

  /**
   * Fetch playlist text from URL
   * @private
   */
  private async fetchPlaylistText(url: string): Promise<string> {
    return await fetchText(url, 1);
  }

  /**
   * Handle media playlist detection
   * @private
   */
  private async handleMediaPlaylist(
    url: string,
    normalizedUrl: string,
    playlistText: string,
  ): Promise<VideoMetadata | null> {
    const belongsToMaster = this.checkIfBelongsToMasterPlaylist(normalizedUrl);

    if (belongsToMaster) {
      logger.debug(
        "[Media Bridge] M3U8 media playlist belongs to a master playlist, removing it",
        url,
      );
      this.removeDetectedVideo(normalizedUrl);
      return null;
    }

    // It's a standalone media playlist, add it as M3U8 format
    logger.info("[Media Bridge] Detected standalone M3U8 media playlist", url);
    return await this.addDetectedVideo(url, "m3u8", playlistText);
  }

  /**
   * Handle master playlist detection
   * @private
   */
  private async handleMasterPlaylist(
    url: string,
    normalizedUrl: string,
    playlistText: string,
  ): Promise<VideoMetadata | null> {
    logger.info("[Media Bridge] Detected HLS Master Playlist", { url });

    const variantUrls = this.trackMasterPlaylist(
      url,
      normalizedUrl,
      playlistText,
    );

    // Remove any existing detected videos that are variants of this master playlist
    this.removeVariantVideos(variantUrls);

    return await this.addDetectedVideo(url, "hls", playlistText);
  }

  /**
   * Track master playlist and extract variant URLs
   * @private
   */
  private trackMasterPlaylist(
    url: string,
    normalizedUrl: string,
    playlistText: string,
  ): Set<string> {
    const levels = parseMasterPlaylist(playlistText, url);
    const variantUrls = new Set<string>();

    levels.forEach((level) => {
      const normalizedVariantUrl = normalizeUrl(level.uri);
      variantUrls.add(normalizedVariantUrl);
    });

    this.masterPlaylists.set(normalizedUrl, {
      url,
      variantUrls,
      playlistText,
    });

    return variantUrls;
  }

  /**
   * Remove detected video if callback is available
   * @private
   */
  private removeDetectedVideo(normalizedUrl: string): void {
    if (this.onVideoRemoved) {
      this.onVideoRemoved(normalizedUrl);
    }
  }

  /**
   * Extract metadata and notify about detected video
   * @private
   */
  private async addDetectedVideo(
    url: string,
    format: "hls" | "m3u8",
    playlistText: string,
  ): Promise<VideoMetadata | null> {
    const metadata = await this.extractMetadata(url, format, playlistText);

    if (metadata && this.onVideoDetected) {
      this.onVideoDetected(metadata);
    }

    return metadata;
  }

  /**
   * Handle network request for HLS playlist
   * Triggers detection for HLS URLs
   */
  handleNetworkRequest(url: string): void {
    if (this.isHlsUrl(url)) {
      // Trigger detection for HLS URL
      this.detect(url);
    }
  }

  /**
   * Check if URL is an HLS playlist URL
   * @private
   */
  private isHlsUrl(url: string): boolean {
    const urlLower = url.toLowerCase();
    return urlLower.includes(".m3u8") || !!urlLower.match(/\.m3u8(\?|$|#)/);
  }

  /**
   * Check if content type indicates HLS playlist
   * @param contentType - Content-Type header value
   * @returns True if content type indicates HLS playlist
   */
  isHlsContentType(contentType: string): boolean {
    const contentTypeLower = contentType.toLowerCase();
    return (
      contentTypeLower.includes("application/vnd.apple.mpegurl") ||
      contentTypeLower.includes("application/x-mpegurl")
    );
  }

  /**
   * Check if a media playlist URL belongs to any tracked master playlist
   * @private
   */
  private checkIfBelongsToMasterPlaylist(mediaPlaylistUrl: string): boolean {
    for (const [masterUrl, masterInfo] of this.masterPlaylists.entries()) {
      if (masterInfo.variantUrls.has(mediaPlaylistUrl)) {
        return true;
      }
      // Also check using the parser function for more robust matching
      try {
        if (
          belongsToMasterPlaylist(
            masterInfo.playlistText,
            masterInfo.url,
            mediaPlaylistUrl,
          )
        ) {
          return true;
        }
      } catch (error) {
        logger.error(
          "[Media Bridge] Error checking master playlist membership",
          { error },
        );
      }
    }
    return false;
  }

  /**
   * Remove variant videos that belong to master playlists
   * @private
   */
  private removeVariantVideos(variantUrls: Set<string>): void {
    if (!this.onVideoRemoved) {
      return;
    }

    const onVideoRemoved = this.onVideoRemoved;
    variantUrls.forEach((variantUrl) => {
      logger.debug(
        "[Media Bridge] Removing variant video that belongs to master playlist",
        { variantUrl },
      );
      onVideoRemoved(variantUrl);
    });
  }

  /**
   * Extract metadata from HLS playlist URL
   * @private
   */
  private async extractMetadata(
    url: string,
    format: "hls" | "m3u8" = "hls",
    playlistText: string,
  ): Promise<VideoMetadata | null> {
    const metadata: VideoMetadata = {
      url,
      format,
      pageUrl: window.location.href,
      title: document.title,
      fileExtension: "m3u8",
      hasDrm: hasDrm(playlistText),
      cannotDecrypt: !canDecrypt(playlistText),
    };

    // Extract thumbnail using unified utility (page-based search)
    const thumbnail = extractThumbnail();
    if (thumbnail) {
      metadata.thumbnail = thumbnail;
    }

    return metadata;
  }
}
