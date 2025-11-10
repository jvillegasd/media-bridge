/**
 * Main detection manager that orchestrates video detection
 */

import { VideoFormat, VideoMetadata } from '../types';
import { FormatDetector } from './format-detector';
import { DirectDetectionHandler } from './direct/direct-detection-handler';
import { HlsDetectionHandler } from './hls/hls-detection-handler';

export interface DetectionManagerOptions {
  onVideoDetected?: (video: VideoMetadata) => void;
}

export class DetectionManager {
  private onVideoDetected?: (video: VideoMetadata) => void;
  private directHandler: DirectDetectionHandler;
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
    const format: VideoFormat = await FormatDetector.detectWithInspection(url);
    
    // Route to appropriate handler based on format
    switch (format) {
      case 'direct':
        return await this.directHandler.detect(url, videoElement);
      
      case 'hls':
        return await this.hlsHandler.detect(url);
      
      default:
        // Default to direct for unknown formats
        return await this.directHandler.detect(url, videoElement);
    }
  }

  /**
   * Detect videos from network request
   */
  handleNetworkRequest(url: string): void {
    const format = FormatDetector.detectFromUrl(url);
    
    switch (format) {
      case 'direct':
        this.directHandler.handleNetworkRequest(url);
        break;
      
      case 'hls':
        this.hlsHandler.handleNetworkRequest(url);
        break;
    }
  }

  /**
   * Scan DOM for video elements
   */
  async scanDOM(): Promise<VideoMetadata[]> {
    const videoElements = document.querySelectorAll('video');
    const detectedVideos: VideoMetadata[] = [];

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
        detectedVideos.push(metadata);
      }
    }

    return detectedVideos;
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

