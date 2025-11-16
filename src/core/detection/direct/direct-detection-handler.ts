/**
 * Direct video detection handler - orchestrates direct video detection
 * 
 * This handler is responsible for detecting direct video file URLs (e.g., .mp4, .webm, .mov files)
 * from network requests and DOM video elements. It monitors the DOM for video elements and
 * associates network requests with those elements to extract comprehensive metadata.
 * 
 * Key features:
 * - Detects direct video URLs from network requests
 * - Monitors DOM for video elements using MutationObserver
 * - Associates network requests with video elements
 * - Extracts metadata from video elements (dimensions, duration, thumbnails)
 * - Filters out audio-only URLs
 * - Performs initial DOM scan and continuous monitoring
 * 
 * Detection process:
 * 1. Network requests are intercepted and checked for direct video URLs
 * 2. URLs are associated with video elements in the DOM
 * 3. DOM observer monitors for dynamically added video elements
 * 4. Metadata is extracted from video elements (dimensions, duration, thumbnails)
 * 5. Detected videos trigger callbacks with complete metadata
 * 
 * @module DirectDetectionHandler
 */

import { VideoMetadata } from "../../types";
import { detectFormatFromUrl } from "../../utils/url-utils";

/** Configuration options for DirectDetectionHandler */
export interface DirectDetectionHandlerOptions {
  /** Optional callback for detected videos */
  onVideoDetected?: (video: VideoMetadata) => void;
}

/**
 * Direct video detection handler
 * Detects direct video URLs from network requests and DOM elements
 */
export class DirectDetectionHandler {
  private onVideoDetected?: (video: VideoMetadata) => void;
  private capturedUrls = new Map<HTMLVideoElement, string>();

  /**
   * Create a new DirectDetectionHandler instance
   * @param options - Configuration options
   */
  constructor(options: DirectDetectionHandlerOptions = {}) {
    this.onVideoDetected = options.onVideoDetected;
  }

  /**
   * Detect direct video from URL
   * @param url - Video URL to detect
   * @param videoElement - Optional video element for metadata extraction
   * @returns Promise resolving to VideoMetadata or null if not detected
   */
  async detect(
    url: string,
    videoElement?: HTMLVideoElement,
  ): Promise<VideoMetadata | null> {
    // Check if URL is a direct video URL
    if (!this.isDirectVideoUrl(url)) {
      return null;
    }

    // Check if it's audio-only (skip it)
    if (this.isAudioOnlyUrl(url)) {
      console.log("[Media Bridge] Skipping audio-only URL:", url);
      return null;
    }

    // Store captured URL if we have a video element
    if (videoElement) {
      this.capturedUrls.set(videoElement, url);
    }

    // Extract metadata
    const metadata = await this.extractMetadata(url, videoElement);

    if (metadata && this.onVideoDetected) {
      this.onVideoDetected(metadata);
    }

    return metadata;
  }

  /**
   * Handle network request for direct video
   * Associates URL with video elements and triggers detection
   */
  handleNetworkRequest(url: string): void {
    if (this.isDirectVideoUrl(url) && !this.isAudioOnlyUrl(url)) {
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
   * @private
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
   * Scan DOM for video elements and trigger detection
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
   * @private
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

  /**
   * Check if URL is a direct video URL
   * @private
   */
  private isDirectVideoUrl(url: string): boolean {
    return (
      url.includes(".mp4") ||
      url.includes(".webm") ||
      url.includes(".mov") ||
      url.includes(".avi") ||
      url.includes(".mkv") ||
      url.includes(".flv") ||
      url.includes(".wmv") ||
      url.includes(".ogg")
    );
  }

  /**
   * Check if URL is audio-only (not a video track)
   * @private
   */
  private isAudioOnlyUrl(url: string): boolean {
    const lowerUrl = url.toLowerCase();

    const audioPatterns = [
      "/aud/",
      "/audio/",
      "/mp4a/",
      "/aac/",
      "/audio_track",
      "/sound/",
    ];

    if (audioPatterns.some((pattern) => lowerUrl.includes(pattern))) {
      return true;
    }

    // For Twitter/X amplify_video URLs
    if (lowerUrl.includes("amplify_video")) {
      if (lowerUrl.includes("/aud/")) {
        return true;
      }
      if (lowerUrl.includes("/vid/") || lowerUrl.includes("/video/")) {
        return false;
      }
    }

    return false;
  }

  /**
   * Extract metadata from direct video URL
   * @private
   */
  private async extractMetadata(
    url: string,
    videoElement?: HTMLVideoElement,
  ): Promise<VideoMetadata | null> {
    const format = detectFormatFromUrl(url);

    // Reject unknown formats
    if (format === "unknown") {
      return null;
    }

    const metadata: VideoMetadata = {
      url,
      format,
      pageUrl: window.location.href,
      title: document.title,
    };

    // Extract metadata from video element if available
    if (videoElement) {
      metadata.width = videoElement.videoWidth || undefined;
      metadata.height = videoElement.videoHeight || undefined;
      metadata.duration = videoElement.duration || undefined;

      if (metadata.width && metadata.height) {
        const height = metadata.height;
        if (height >= 2160) {
          metadata.resolution = "4K";
        } else if (height >= 1440) {
          metadata.resolution = "1440p";
        } else if (height >= 1080) {
          metadata.resolution = "1080p";
        } else if (height >= 720) {
          metadata.resolution = "720p";
        } else if (height >= 480) {
          metadata.resolution = "480p";
        } else {
          metadata.resolution = `${height}p`;
        }
      }

      // Extract thumbnail
      if (videoElement.poster) {
        metadata.thumbnail = videoElement.poster;
      } else {
        // Try to capture current frame as thumbnail
        try {
          if (videoElement.readyState >= 2) {
            const canvas = document.createElement("canvas");
            canvas.width = videoElement.videoWidth || 320;
            canvas.height = videoElement.videoHeight || 180;
            const ctx = canvas.getContext("2d");
            if (ctx) {
              ctx.drawImage(videoElement, 0, 0, canvas.width, canvas.height);
              metadata.thumbnail = canvas.toDataURL("image/jpeg", 0.8);
            }
          }
        } catch (error) {
          // CORS or other issues, ignore
        }
      }

      // Try to find a more specific title from the page context
      if (
        !metadata.title ||
        metadata.title.trim().length === 0 ||
        metadata.title.includes(" - ") ||
        metadata.title.includes(" / ")
      ) {
        let container = videoElement.parentElement;
        let depth = 0;

        while (container && depth < 3) {
          const heading = container.querySelector("h1, h2, h3, h4, h5, h6");
          if (heading) {
            const headingText = heading.textContent?.trim();
            if (
              headingText &&
              headingText.length > 0 &&
              headingText.length < 200
            ) {
              metadata.title = headingText;
              break;
            }
          }

          const ogTitle = document.querySelector('meta[property="og:title"]');
          if (ogTitle) {
            const ogTitleContent = (ogTitle as HTMLMetaElement).content?.trim();
            if (ogTitleContent && ogTitleContent.length > 0) {
              metadata.title = ogTitleContent;
              break;
            }
          }

          container = container.parentElement;
          depth++;
        }

        if (!metadata.title || metadata.title.trim().length === 0) {
          metadata.title = videoElement.getAttribute("title") || document.title;
        }
      }
    } else {
      // Try to find thumbnail in page (for YouTube, Twitter, etc.)
      const thumbnailSelectors = [
        'meta[property="og:image"]',
        'meta[name="twitter:image"]',
        'link[rel="image_src"]',
        'img[class*="thumbnail"]',
        'img[class*="preview"]',
      ];

      for (const selector of thumbnailSelectors) {
        const element = document.querySelector(selector);
        if (element) {
          const thumbnailUrl =
            element.getAttribute("content") ||
            element.getAttribute("href") ||
            (element as HTMLImageElement).src;
          if (thumbnailUrl) {
            metadata.thumbnail = thumbnailUrl;
            break;
          }
        }
      }
    }

    return metadata;
  }
}
