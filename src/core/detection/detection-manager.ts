/**
 * Main detection manager - orchestrates video detection
 * 
 * This manager serves as the central coordinator for video detection across different formats.
 * It routes detection requests to format-specific handlers (direct, HLS) and manages the
 * overall detection lifecycle.
 * 
 * Key features:
 * - Routes network requests to appropriate detection handlers based on URL format
 * - Initializes DOM observers for direct video detection
 * - Coordinates between direct and HLS detection handlers
 * - Provides unified callbacks for video detection and removal events
 * 
 * Detection process:
 * 1. Network requests are intercepted and analyzed for video format
 * 2. Requests are routed to format-specific handlers (direct or HLS)
 * 3. DOM observers monitor for dynamically added video elements
 * 4. Detected videos trigger callbacks with metadata
 * 
 * @module DetectionManager
 */

import { VideoMetadata } from "../types";
import { logger } from "../utils/logger";
import { detectFormatFromUrl } from "../utils/url-utils";
import { DirectDetectionHandler } from "./direct/direct-detection-handler";
import { HlsDetectionHandler } from "./hls/hls-detection-handler";

/** Configuration options for DetectionManager */
export interface DetectionManagerOptions {
  /** Optional callback for detected videos */
  onVideoDetected?: (video: VideoMetadata) => void;
  /** Optional callback for removed videos */
  onVideoRemoved?: (url: string) => void;
}

/**
 * Main detection manager that orchestrates video detection
 * Routes requests to format-specific handlers and manages detection lifecycle
 */
export class DetectionManager {
  private onVideoDetected?: (video: VideoMetadata) => void;
  private onVideoRemoved?: (url: string) => void;
  public readonly directHandler: DirectDetectionHandler;
  private hlsHandler: HlsDetectionHandler;

  /**
   * Create a new DetectionManager instance
   * @param options - Configuration options
   */
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
   * Routes to format-specific handler based on URL format
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
   */
  init(): void {
    // Set up DOM observer (for direct video detection)
    this.directHandler.setupDOMObserver();

    // Perform initial scan (for direct video detection)
    this.directHandler.scanDOMForVideos();
  }

  /**
   * Handle detected video
   * @private
   */
  private handleVideoDetected(video: VideoMetadata): void {
    if (this.onVideoDetected) {
      this.onVideoDetected(video);
    }
  }

  /**
   * Handle video removal
   * @private
   */
  private handleVideoRemoved(url: string): void {
    if (this.onVideoRemoved) {
      this.onVideoRemoved(url);
    }
  }
}
