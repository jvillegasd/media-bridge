/**
 * Main detection manager that orchestrates video detection
 */

import { VideoFormat, VideoMetadata } from "../types";
import { detectFormatFromUrl } from "../utils/url-utils";
import { DirectDetectionHandler } from "./direct/direct-detection-handler";
import { HlsDetectionHandler } from "./hls/hls-detection-handler";

export interface DetectionManagerOptions {
  onVideoDetected?: (video: VideoMetadata) => void;
}

export class DetectionManager {
  private onVideoDetected?: (video: VideoMetadata) => void;
  public readonly directHandler: DirectDetectionHandler;
  private hlsHandler: HlsDetectionHandler;

  constructor(options: DetectionManagerOptions = {}) {
    this.onVideoDetected = options.onVideoDetected;
    this.directHandler = new DirectDetectionHandler({
      onVideoDetected: (video) => this.handleVideoDetected(video),
    });
    this.hlsHandler = new HlsDetectionHandler({
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
        return await this.hlsHandler.detect(url);

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
        this.hlsHandler.handleNetworkRequest(url);
        break;

      case "unknown":
        // Reject unknown formats - don't process them
        break;
    }
  }

  /**
   * Initialize all detection mechanisms
   * Sets up network interceptors, DOM observer, and performs initial scan
   */
  init(): void {
    // Set up network interceptors (for ALL formats detection)
    this.setupNetworkInterceptor();

    // Set up DOM observer (for direct video detection)
    this.directHandler.setupDOMObserver();

    // Perform initial scan (for direct video detection)
    this.directHandler.scanDOMForVideos();
  }

  /**
   * Set up network interceptors (fetch and XMLHttpRequest) to capture video URLs
   */
  setupNetworkInterceptor(): void {
    const manager = this;
    const originalFetch = window.fetch;
    window.fetch = async function (
      input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> {
      let url: string | null = null;
      if (typeof input === "string") {
        url = input;
      } else if (input instanceof URL) {
        url = input.href;
      } else if (input instanceof Request) {
        url = input.url;
      }

      if (url) {
        manager.handleNetworkRequest(url);
      }
      return originalFetch.call(this, input, init);
    };

    const originalXHROpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (
      method: string,
      url: string | URL,
      async?: boolean,
      username?: string | null,
      password?: string | null,
    ) {
      const urlString = typeof url === "string" ? url : url.toString();
      if (urlString) {
        manager.handleNetworkRequest(urlString);
      }
      return originalXHROpen.call(
        this,
        method,
        url,
        async !== undefined ? async : true,
        username,
        password,
      );
    };
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
