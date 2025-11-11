/**
 * Detects video format from URL
 */

import { VideoFormat } from "../types";

export class FormatDetector {
  /**
   * Detect format from URL
   */
  static detectFromUrl(url: string): VideoFormat {
    // Check URL extension
    const urlLower = url.toLowerCase();

    // Handle blob URLs - these are already video blobs, treat as direct
    if (url.startsWith("blob:")) {
      return "direct";
    }

    // Handle data URLs - treat as direct
    if (url.startsWith("data:")) {
      return "direct";
    }

    let urlObj: URL;
    try {
      urlObj = new URL(url);
    } catch (error) {
      return "unknown";
    }

    // Check for HLS playlist files (.m3u8)
    if (urlLower.includes(".m3u8") || urlLower.match(/\.m3u8(\?|$|#)/)) {
      return "hls";
    }

    // Check for common video extensions
    const videoExtensions = [
      ".mp4",
      ".webm",
      ".ogg",
      ".mov",
      ".avi",
      ".mkv",
      ".flv",
      ".wmv",
    ];
    if (videoExtensions.some((ext) => urlLower.includes(ext))) {
      return "direct";
    }

    // If no clear format detected but it looks like a video URL, assume direct
    // Many video CDNs don't include file extensions
    if (urlObj.pathname.match(/\/(video|stream|media|v|embed)\//i)) {
      return "direct";
    }

    return "unknown";
  }
}
