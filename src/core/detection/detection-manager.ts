/**
 * Main detection manager that orchestrates video detection
 */

import { VideoFormat, VideoMetadata } from "../types";
import { fetchText } from "../utils/fetch-utils";
import { logger } from "../utils/logger";
import { isMasterPlaylist } from "../utils/m3u8-parser";
import { detectFormatFromUrl } from "../utils/url-utils";
import { DirectDetectionHandler } from "./direct/direct-detection-handler";
import { HlsDetectionHandler } from "./hls/hls-detection-handler";
import { M3u8DetectionHandler } from "./m3u8/m3u8-detection-handler";

export interface DetectionManagerOptions {
  onVideoDetected?: (video: VideoMetadata) => void;
}

export class DetectionManager {
  private onVideoDetected?: (video: VideoMetadata) => void;
  public readonly directHandler: DirectDetectionHandler;
  private hlsHandler: HlsDetectionHandler;
  private m3u8Handler: M3u8DetectionHandler;

  constructor(options: DetectionManagerOptions = {}) {
    this.onVideoDetected = options.onVideoDetected;
    this.directHandler = new DirectDetectionHandler({
      onVideoDetected: (video) => this.handleVideoDetected(video),
    });
    this.hlsHandler = new HlsDetectionHandler({
      onVideoDetected: (video) => this.handleVideoDetected(video),
    });
    this.m3u8Handler = new M3u8DetectionHandler({
      onVideoDetected: (video) => this.handleVideoDetected(video),
    });
  }

  /**
   * Detect videos from network request
   */
  handleNetworkRequest(url: string): void {
    const format = detectFormatFromUrl(url);

    switch (format) {
      case "direct":
        logger.info("[Media Bridge] Direct video detected", { url });
        this.directHandler.handleNetworkRequest(url);
        break;

      case "hls":
        this.handleHlsNetworkRequest(url);
        break;

      default:
        // Reject unknown formats - don't process them
        logger.info("[Media Bridge] Unknown format detected", { url });
        break;
    }
  }

  /**
   * Initialize all detection mechanisms
   * Sets up DOM observer and performs initial scan
   * Note: Network interception is handled by the service worker
   */
  init(): void {
    // Set up DOM observer (for direct video detection)
    this.directHandler.setupDOMObserver();

    // Perform initial scan (for direct video detection)
    this.directHandler.scanDOMForVideos();
  }

  /**
   * Handle detected video
   */
  private handleVideoDetected(video: VideoMetadata): void {
    if (this.onVideoDetected) {
      this.onVideoDetected(video);
    }
  }

  private async handleHlsNetworkRequest(url: string): Promise<void> {
    try {
      const playlistText = await fetchText(url, 1);
      logger.info("[Media Bridge] HLS playlist text", { playlistText });

      if (isMasterPlaylist(playlistText)) {
        logger.debug("[Media Bridge] HLS Master Playlist detected", url);
        this.hlsHandler.handleNetworkRequest(url);
      } else {
        logger.debug("[Media Bridge] M3U8 Media Playlist detected", url);
        this.m3u8Handler.handleNetworkRequest(url);
      }
    } catch (error) {
      logger.error("[Media Bridge] Error handling HLS network request", {
        url,
        error,
      });
    }
  }
}
