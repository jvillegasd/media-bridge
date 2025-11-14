/**
 * HLS detection handler - orchestrates HLS playlist detection
 */

import { VideoMetadata } from "../../types";
import { isMasterPlaylist } from "../../utils/m3u8-parser";
import { fetchText } from "../../utils/fetch-utils";

export interface HlsDetectionHandlerOptions {
  onVideoDetected?: (video: VideoMetadata) => void;
}

export class HlsDetectionHandler {
  private onVideoDetected?: (video: VideoMetadata) => void;

  constructor(options: HlsDetectionHandlerOptions = {}) {
    this.onVideoDetected = options.onVideoDetected;
  }

  /**
   * Detect HLS playlist from URL
   */
  async detect(url: string): Promise<VideoMetadata | null> {
    // Check if URL is an HLS playlist URL
    if (!this.isHlsUrl(url)) {
      return null;
    }

    // Validate that this is a master playlist before proceeding
    try {
      const playlistText = await fetchText(url, 1);
      console.debug("[Media Bridge] HLS playlist text:", playlistText);
      const isMaster = isMasterPlaylist(playlistText);

      // If it's not a master playlist, don't add it to the UI
      if (!isMaster) {
        console.log("[Media Bridge] Not a HLS master playlist, skipping");
        return null;
      }

      console.log("[Media Bridge] Is a HLS master playlist, proceeding");
    } catch (error) {
      // If we can't fetch or parse the playlist, don't add it to the UI
      console.debug(
        "[Media Bridge] Failed to validate HLS playlist as master:",
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
   * Extract metadata from HLS playlist URL
   */
  private async extractMetadata(url: string): Promise<VideoMetadata | null> {
    const metadata: VideoMetadata = {
      url,
      format: "hls",
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
