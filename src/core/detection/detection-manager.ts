/**
 * Main detection manager that orchestrates video detection
 */

import { VideoFormat, VideoMetadata } from '../types';
import { detectFormatFromUrl } from '../utils/url-utils';
import { DirectDetectionHandler } from './direct/direct-detection-handler';
import { HlsDetectionHandler } from './hls/hls-detection-handler';

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
      case 'direct':
        return await this.directHandler.detect(url, videoElement);
      
      case 'hls':
        return await this.hlsHandler.detect(url);
      
      case 'unknown':
        return null;
    }
  }

  /**
   * Detect videos from network request
   */
  handleNetworkRequest(url: string): void {
    const format = detectFormatFromUrl(url);
    
    switch (format) {
      case 'direct':
        this.directHandler.handleNetworkRequest(url);
        break;
      
      case 'hls':
        this.hlsHandler.handleNetworkRequest(url);
        break;
      
      case 'unknown':
        // Reject unknown formats - don't process them
        break;
    }
  }

  /**
   * Scan DOM for video elements and trigger onVideoDetected callback
   */
  async scanDOMForVideos(): Promise<void> {
    const videoElements = document.querySelectorAll('video');

    for (const video of Array.from(videoElements)) {
      const vid = video as HTMLVideoElement;
      
      // Skip very small videos (likely icons or UI elements)
      if (
        vid.videoWidth > 0 &&
        vid.videoHeight > 0 &&
        (vid.videoWidth < 50 || vid.videoHeight < 50)
      ) {
        continue;
      }

      // Skip if video element isn't ready (check if it has any URL)
      const hasUrl = vid.currentSrc || vid.src || vid.querySelector('source');
      if (vid.readyState === 0 && !hasUrl) {
        continue;
      }

      // Try to detect from video element using format-specific handlers
      // HLS detection only cares about URLs, so skip it for video elements
      // Only try direct detection from video elements
      const metadata = await this.directHandler.detectFromVideoElement(vid);
      if (metadata) {
        console.log("[Media Bridge] Detected video:", {
          url: metadata.url,
          format: metadata.format,
          pageUrl: metadata.pageUrl,
        });
        this.handleVideoDetected(metadata);
      }
    }
  }

  /**
   * Initialize all detection mechanisms
   * Sets up network interceptors, DOM observer, and performs initial scan
   */
  init(): void {
    // Set up network interceptors (for both direct and HLS detection)
    this.setupNetworkInterceptor();

    // Set up DOM observer (for direct video detection)
    this.directHandler.setupDOMObserver(() => {
      this.scanDOMForVideos();
    });

    // Perform initial scan
    this.scanDOMForVideos();
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

