/**
 * Main detection manager that orchestrates video detection
 */

import { VideoFormat, VideoMetadata } from "../types";
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
   * Detect video from URL
   */
  async detectFromUrl(
    url: string,
    videoElement?: HTMLVideoElement,
  ): Promise<VideoMetadata | null> {
    // Detect format
    const format: VideoFormat = detectFormatFromUrl(url);

    // Route to appropriate handler based on format
    switch (format) {
      case "direct":
        return await this.directHandler.detect(url, videoElement);

      case "hls":
        // For .m3u8 URLs, try both master playlist (HLS) and media playlist (M3U8) detection
        // Try HLS (master playlist) first
        const hlsResult = await this.hlsHandler.detect(url);
        if (hlsResult) {
          return hlsResult;
        }
        // If not a master playlist, try M3U8 (media playlist)
        return await this.m3u8Handler.detect(url);

      case "m3u8":
        return await this.m3u8Handler.detect(url);

      case "unknown":
        return null;
    }
  }

  /**
   * Detect videos from network request
   */
  handleNetworkRequest(url: string): void {
    const format = detectFormatFromUrl(url);

    switch (format) {
      case "direct":
        this.directHandler.handleNetworkRequest(url);
        break;

      case "hls":
        // For .m3u8 URLs, try both handlers
        this.hlsHandler.handleNetworkRequest(url);
        this.m3u8Handler.handleNetworkRequest(url);
        break;

      case "m3u8":
        this.m3u8Handler.handleNetworkRequest(url);
        break;

      case "unknown":
        // Reject unknown formats - don't process them
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
}
