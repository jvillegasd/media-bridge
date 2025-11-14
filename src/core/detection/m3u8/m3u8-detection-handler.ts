/**
 * M3U8 media playlist detection handler - detects m3u8 media playlists (not master playlists)
 */

import { VideoMetadata } from "../../types";
import { isMediaPlaylist } from "../../utils/m3u8-parser";
import { fetchText } from "../../utils/fetch-utils";
import { logger } from "../../utils/logger";

export interface M3u8DetectionHandlerOptions {
  onVideoDetected?: (video: VideoMetadata) => void;
}

export class M3u8DetectionHandler {
  private onVideoDetected?: (video: VideoMetadata) => void;

  constructor(options: M3u8DetectionHandlerOptions = {}) {
    this.onVideoDetected = options.onVideoDetected;
  }

  /**
   * Detect M3U8 media playlist from URL
   */
  async detect(url: string): Promise<VideoMetadata | null> {
    // Check if URL is an M3U8 playlist URL
    if (!this.isM3u8Url(url)) {
      return null;
    }

    // Validate that this is a media playlist (not a master playlist) before proceeding
    try {
      const playlistText = await fetchText(url, 1);
      console.debug("[Media Bridge] M3U8 playlist text:", playlistText);
      const isMedia = isMediaPlaylist(playlistText);

      // If it's not a media playlist, don't add it to the UI
      if (!isMedia) {
        console.log("[Media Bridge] Not a M3U8 media playlist, skipping");
        return null;
      }

      console.log("[Media Bridge] Is a M3U8 media playlist, proceeding");
    } catch (error) {
      // If we can't fetch or parse the playlist, don't add it to the UI
      console.debug(
        "[Media Bridge] Failed to validate M3U8 playlist as media:",
        error,
      );
      return null;
    }

    // Extract metadata
    const metadata = await this.extractMetadata(url);

    if (metadata && this.onVideoDetected) {
      this.onVideoDetected(metadata);
    }

    return metadata;
  }

  /**
   * Handle network request for M3U8 media playlist
   */
  handleNetworkRequest(url: string): void {
    if (this.isM3u8Url(url)) {
      // Trigger detection for M3U8 URL
      this.detect(url);
    }
  }

  /**
   * Check if URL is an M3U8 playlist URL
   */
  private isM3u8Url(url: string): boolean {
    const urlLower = url.toLowerCase();
    return urlLower.includes(".m3u8") || !!urlLower.match(/\.m3u8(\?|$|#)/);
  }

  /**
   * Check if content type indicates M3U8 playlist
   */
  isM3u8ContentType(contentType: string): boolean {
    const contentTypeLower = contentType.toLowerCase();
    return (
      contentTypeLower.includes("application/vnd.apple.mpegurl") ||
      contentTypeLower.includes("application/x-mpegurl")
    );
  }

  /**
   * Extract metadata from M3U8 media playlist URL
   */
  private async extractMetadata(url: string): Promise<VideoMetadata | null> {
    const metadata: VideoMetadata = {
      url,
      format: "m3u8",
      pageUrl: window.location.href,
      title: document.title,
      fileExtension: "m3u8",
    };

    logger.info("Extracting metadata", { metadata });

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

