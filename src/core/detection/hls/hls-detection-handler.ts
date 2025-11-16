/**
 * HLS detection handler - orchestrates HLS playlist detection
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

export interface HlsDetectionHandlerOptions {
  onVideoDetected?: (video: VideoMetadata) => void;
  onVideoRemoved?: (url: string) => void;
}

interface MasterPlaylistInfo {
  url: string;
  variantUrls: Set<string>;
  playlistText: string;
}

export class HlsDetectionHandler {
  private onVideoDetected?: (video: VideoMetadata) => void;
  private onVideoRemoved?: (url: string) => void;
  // Track master playlists and their variants
  private masterPlaylists: Map<string, MasterPlaylistInfo> = new Map();

  constructor(options: HlsDetectionHandlerOptions = {}) {
    this.onVideoDetected = options.onVideoDetected;
    this.onVideoRemoved = options.onVideoRemoved;
  }

  /**
   * Detect HLS playlist from URL
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
        return await this.handleMediaPlaylist(url, normalizedUrl);
      }

      if (isMaster) {
        return await this.handleMasterPlaylist(url, normalizedUrl, playlistText);
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
   */
  private async fetchPlaylistText(url: string): Promise<string> {
    return await fetchText(url, 1);
  }

  /**
   * Handle media playlist detection
   */
  private async handleMediaPlaylist(
    url: string,
    normalizedUrl: string,
  ): Promise<VideoMetadata | null> {
    const belongsToMaster =
      this.checkIfBelongsToMasterPlaylist(normalizedUrl);

    if (belongsToMaster) {
      logger.debug(
        "[Media Bridge] M3U8 media playlist belongs to a master playlist, removing it",
        { url },
      );
      this.removeDetectedVideo(normalizedUrl);
      return null;
    }

    // It's a standalone media playlist, add it as M3U8 format
    logger.info("[Media Bridge] Detected standalone M3U8 media playlist", {
      url,
    });
    return await this.addDetectedVideo(url, "m3u8");
  }

  /**
   * Handle master playlist detection
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

    return await this.addDetectedVideo(url, "hls");
  }

  /**
   * Track master playlist and extract variant URLs
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
   */
  private removeDetectedVideo(normalizedUrl: string): void {
    if (this.onVideoRemoved) {
      this.onVideoRemoved(normalizedUrl);
    }
  }

  /**
   * Extract metadata and notify about detected video
   */
  private async addDetectedVideo(
    url: string,
    format: "hls" | "m3u8",
  ): Promise<VideoMetadata | null> {
    const metadata = await this.extractMetadata(url, format);

    if (metadata && this.onVideoDetected) {
      this.onVideoDetected(metadata);
    }

    return metadata;
  }

  /**
   * Handle network request for HLS playlist
   */
  handleNetworkRequest(url: string): void {
    if (this.isHlsUrl(url)) {
      // Trigger detection for HLS URL
      this.detect(url);
    }
  }

  /**
   * Check if URL is an HLS playlist URL
   */
  private isHlsUrl(url: string): boolean {
    const urlLower = url.toLowerCase();
    return urlLower.includes(".m3u8") || !!urlLower.match(/\.m3u8(\?|$|#)/);
  }

  /**
   * Check if content type indicates HLS playlist
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
   */
  private async extractMetadata(
    url: string,
    format: "hls" | "m3u8" = "hls",
  ): Promise<VideoMetadata | null> {
    const metadata: VideoMetadata = {
      url,
      format,
      pageUrl: window.location.href,
      title: document.title,
      fileExtension: "m3u8",
    };

    // Try to find thumbnail in page
    const thumbnailSelectors = [
      'meta[property="og:image"]',
      'meta[name="twitter:image"]',
      'link[rel="image_src"]',
      'img[class*="thumbnail"]',
      'img[class*="preview"]',
    ];

    for (const selector of thumbnailSelectors) {
      const element = document.querySelector(selector);
      if (element) {
        const thumbnailUrl =
          element.getAttribute("content") ||
          element.getAttribute("href") ||
          (element as HTMLImageElement).src;
        if (thumbnailUrl) {
          metadata.thumbnail = thumbnailUrl;
          break;
        }
      }
    }

    return metadata;
  }
}
