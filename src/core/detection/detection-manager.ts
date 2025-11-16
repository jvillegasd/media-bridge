/**
 * Main detection manager that orchestrates video detection
 */

import { VideoMetadata } from "../types";
import { logger } from "../utils/logger";
import { detectFormatFromUrl } from "../utils/url-utils";
import { DirectDetectionHandler } from "./direct/direct-detection-handler";
import { HlsDetectionHandler } from "./hls/hls-detection-handler";

export interface DetectionManagerOptions {
  onVideoDetected?: (video: VideoMetadata) => void;
  onVideoRemoved?: (url: string) => void;
}

export class DetectionManager {
  private onVideoDetected?: (video: VideoMetadata) => void;
  private onVideoRemoved?: (url: string) => void;
  public readonly directHandler: DirectDetectionHandler;
  private hlsHandler: HlsDetectionHandler;

  constructor(options: DetectionManagerOptions = {}) {
    this.onVideoDetected = options.onVideoDetected;
    this.onVideoRemoved = options.onVideoRemoved;
    this.directHandler = new DirectDetectionHandler({
      onVideoDetected: (video) => this.handleVideoDetected(video),
    });
    this.hlsHandler = new HlsDetectionHandler({
      onVideoDetected: (video) => this.handleVideoDetected(video),
      onVideoRemoved: (url) => this.handleVideoRemoved(url),
    });
  }

  /**
   * Detect videos from network request
   */
  handleNetworkRequest(url: string): void {
    const format = detectFormatFromUrl(url);

    switch (format) {
      case "direct":
        logger.debug("[Media Bridge] Direct video detected", { url });
        this.directHandler.handleNetworkRequest(url);
        break;

      case "hls":
        logger.debug("[Media Bridge] HLS video detected", { url });
        this.hlsHandler.handleNetworkRequest(url);
        break;

      default:
        // Reject unknown formats - don't process them
        logger.debug("[Media Bridge] Unknown format detected", { url });
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

  /**
   * Handle video removal
   */
  private handleVideoRemoved(url: string): void {
    if (this.onVideoRemoved) {
      this.onVideoRemoved(url);
    }
  }
}
