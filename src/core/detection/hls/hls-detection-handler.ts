/**
 * HLS detection handler - orchestrates HLS playlist detection
 */

import { VideoMetadata } from "../../types";
import { HlsVideoDetector } from "./hls-video-detector";
import { isMasterPlaylist } from "../../utils/m3u8-parser";
import { fetchText } from "../../utils/fetch-utils";

export interface HlsDetectionHandlerOptions {
  onVideoDetected?: (video: VideoMetadata) => void;
}

export class HlsDetectionHandler {
  private onVideoDetected?: (video: VideoMetadata) => void;
  private detector: HlsVideoDetector;

  constructor(options: HlsDetectionHandlerOptions = {}) {
    this.onVideoDetected = options.onVideoDetected;
    this.detector = new HlsVideoDetector();
  }

  /**
   * Detect HLS playlist from URL
   */
  async detect(url: string): Promise<VideoMetadata | null> {
    // Check if URL is an HLS playlist URL
    if (!this.detector.isHlsUrl(url)) {
      return null;
    }

    // Validate that this is a master playlist before proceeding
    try {
      const playlistText = await fetchText(url, 1);
      console.log("[Media Bridge] HLS playlist text:", playlistText);
      const isMaster = isMasterPlaylist(playlistText);

      // If it's not a master playlist, don't add it to the UI
      if (!isMaster) {
        return null;
      }
    } catch (error) {
      // If we can't fetch or parse the playlist, don't add it to the UI
      console.debug(
        "[Media Bridge] Failed to validate HLS playlist as master:",
        error,
      );
      return null;
    }

    // Extract metadata
    const metadata = await this.detector.extractMetadata(url);

    if (metadata && this.onVideoDetected) {
      this.onVideoDetected(metadata);
    }

    return metadata;
  }

  /**
   * Handle network request for HLS playlist
   */
  handleNetworkRequest(url: string): void {
    if (this.detector.isHlsUrl(url)) {
      // Trigger detection for HLS URL
      this.detect(url);
    }
  }
}
