/**
 * Direct video detection handler - orchestrates direct video detection
 */

import { VideoMetadata } from "../../types";
import { DirectVideoDetector } from "./direct-video-detector";

export interface DirectDetectionHandlerOptions {
  onVideoDetected?: (video: VideoMetadata) => void;
}

export class DirectDetectionHandler {
  private onVideoDetected?: (video: VideoMetadata) => void;
  private detector: DirectVideoDetector;
  private capturedUrls = new Map<HTMLVideoElement, string>();

  constructor(options: DirectDetectionHandlerOptions = {}) {
    this.onVideoDetected = options.onVideoDetected;
    this.detector = new DirectVideoDetector();
  }

  /**
   * Detect direct video from URL
   */
  async detect(
    url: string,
    videoElement?: HTMLVideoElement,
  ): Promise<VideoMetadata | null> {
    // Check if URL is a direct video URL
    if (!this.detector.isDirectVideoUrl(url)) {
      return null;
    }

    // Check if it's audio-only (skip it)
    if (this.detector.isAudioOnlyUrl(url)) {
      console.log("[Media Bridge] Skipping audio-only URL:", url);
      return null;
    }

    // Store captured URL if we have a video element
    if (videoElement) {
      this.capturedUrls.set(videoElement, url);
    }

    // Extract metadata
    const metadata = await this.detector.extractMetadata(url, videoElement);

    if (metadata && this.onVideoDetected) {
      this.onVideoDetected(metadata);
    }

    return metadata;
  }

  /**
   * Handle network request for direct video
   */
  handleNetworkRequest(url: string): void {
    if (
      this.detector.isDirectVideoUrl(url) &&
      !this.detector.isAudioOnlyUrl(url)
    ) {
      // Try to associate with video elements
      const videoElements = document.querySelectorAll("video");
      for (const video of Array.from(videoElements)) {
        const vid = video as HTMLVideoElement;
        const existing = this.capturedUrls.get(vid);

        if (
          !existing ||
          existing.startsWith("blob:") ||
          existing.startsWith("data:")
        ) {
          this.capturedUrls.set(vid, url);
          // Trigger detection
          this.detect(url, vid);
        }
      }
    }
  }

  /**
   * Detect video from video element
   */
  private async detectFromVideoElement(
    video: HTMLVideoElement,
  ): Promise<VideoMetadata | null> {
    // First check if we have a captured URL for this video element
    const capturedUrl = this.capturedUrls.get(video);
    if (capturedUrl) {
      return await this.detect(capturedUrl, video);
    }

    // Try to get URL from video element
    const url = this.getVideoUrl(video);
    if (!url) {
      return null;
    }

    // If it's a blob URL, we need a captured URL
    if (url.startsWith("blob:") || url.startsWith("data:")) {
      // Check if we have a captured URL
      const captured = this.capturedUrls.get(video);
      if (captured) {
        return await this.detect(captured, video);
      }
      return null;
    }

    return await this.detect(url, video);
  }

  /**
   * Scan DOM for video elements and trigger onVideoDetected callback
   */
  async scanDOMForVideos(): Promise<void> {
    const videoElements = document.querySelectorAll("video");

    for (const video of Array.from(videoElements)) {
      const vid = video as HTMLVideoElement;

      // Skip if video element isn't ready (check if it has any URL)
      const hasUrl = vid.currentSrc || vid.src || vid.querySelector("source");
      if (vid.readyState === 0 && !hasUrl) {
        continue;
      }

      // Try to detect from video element
      const metadata = await this.detectFromVideoElement(vid);
      if (metadata) {
        console.log("[Media Bridge] Detected video:", {
          url: metadata.url,
          format: metadata.format,
          pageUrl: metadata.pageUrl,
        });
        if (this.onVideoDetected) {
          this.onVideoDetected(metadata);
        }
      }
    }
  }

  /**
   * Set up MutationObserver to monitor DOM changes for dynamically added video elements
   */
  setupDOMObserver(): void {
    const handler = this;
    const observer = new MutationObserver((mutations) => {
      let shouldScan = false;
      for (const mutation of mutations) {
        for (const node of Array.from(mutation.addedNodes)) {
          if (node.nodeType === Node.ELEMENT_NODE) {
            const element = node as Element;
            if (element.tagName === "VIDEO" || element.querySelector("video")) {
              shouldScan = true;
              break;
            }
          }
        }
        if (shouldScan) break;
      }

      if (shouldScan) {
        clearTimeout((observer as any).timeout);
        (observer as any).timeout = setTimeout(() => {
          handler.scanDOMForVideos();
        }, 1000);
      }
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true,
    });
  }

  /**
   * Get video URL from video element
   */
  private getVideoUrl(video: HTMLVideoElement): string | null {
    // Check currentSrc (what's actually playing)
    if (
      video.currentSrc &&
      !video.currentSrc.startsWith("blob:") &&
      !video.currentSrc.startsWith("data:")
    ) {
      return video.currentSrc;
    }

    // Check src attribute
    if (
      video.src &&
      !video.src.startsWith("blob:") &&
      !video.src.startsWith("data:")
    ) {
      return video.src;
    }

    // Check all source elements
    const sources = video.querySelectorAll("source");
    for (const sourceEl of Array.from(sources)) {
      const source = sourceEl as HTMLSourceElement;
      if (
        source.src &&
        !source.src.startsWith("blob:") &&
        !source.src.startsWith("data:")
      ) {
        return source.src;
      }
    }

    return null;
  }
}
