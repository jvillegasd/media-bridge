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

import { VideoMetadata, VideoFormat } from "../../types";
import { detectFormatFromUrl } from "../../utils/url-utils";
import { extractThumbnail } from "../../utils/thumbnail-utils";

const DOM_SCAN_DEBOUNCE_MS = 1000;
const MAX_HEADING_SEARCH_DEPTH = 3;
const MAX_HEADING_TITLE_LENGTH = 200;

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
  private observer: MutationObserver | null = null;
  private scanTimeout: ReturnType<typeof setTimeout> | null = null;
  private knownVideos = new WeakSet<HTMLVideoElement>();

  /**
   * Create a new DirectDetectionHandler instance
   * @param options - Configuration options
   */
  constructor(options: DirectDetectionHandlerOptions = {}) {
    this.onVideoDetected = options.onVideoDetected;
  }

  /**
   * Clean up all resources to prevent memory leaks
   */
  destroy(): void {
    if (this.observer) {
      this.observer.disconnect();
      this.observer = null;
    }
    if (this.scanTimeout) {
      clearTimeout(this.scanTimeout);
      this.scanTimeout = null;
    }
    this.capturedUrls.clear();
    this.knownVideos = new WeakSet();
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
      // Query DOM for current video elements and filter to known ones
      const videos = document.querySelectorAll("video");
      for (const node of Array.from(videos)) {
        const vid = node as HTMLVideoElement;
        if (!this.knownVideos.has(vid)) continue;

        const existing = this.capturedUrls.get(vid);

        if (
          !existing ||
          existing.startsWith("blob:") ||
          existing.startsWith("data:")
        ) {
          this.capturedUrls.set(vid, url);
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
    const readyVideos: HTMLVideoElement[] = [];

    for (const video of Array.from(videoElements)) {
      const vid = video as HTMLVideoElement;
      this.knownVideos.add(vid);

      const hasUrl = vid.currentSrc || vid.src || vid.querySelector("source");
      if (vid.readyState === 0 && !hasUrl) {
        continue;
      }
      readyVideos.push(vid);
    }

    // Detect all ready videos in parallel
    const results = await Promise.allSettled(
      readyVideos.map((vid) => this.detectFromVideoElement(vid)),
    );

    for (const result of results) {
      if (result.status === "fulfilled" && result.value) {
        console.log("[Media Bridge] Detected video:", {
          url: result.value.url,
          format: result.value.format,
          pageUrl: result.value.pageUrl,
        });
        if (this.onVideoDetected) {
          this.onVideoDetected(result.value);
        }
      }
    }
  }

  /**
   * Set up MutationObserver to monitor DOM changes for dynamically added video elements
   */
  setupDOMObserver(): void {
    this.observer = new MutationObserver((mutations) => {
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
        if (this.scanTimeout) {
          clearTimeout(this.scanTimeout);
        }
        this.scanTimeout = setTimeout(() => {
          this.scanTimeout = null;
          this.scanDOMForVideos();
        }, DOM_SCAN_DEBOUNCE_MS);
      }
    });

    this.observer.observe(document.body, {
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
    if (format === VideoFormat.UNKNOWN) {
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

      // Extract thumbnail using unified utility
      const thumbnail = extractThumbnail(videoElement);
      if (thumbnail) {
        metadata.thumbnail = thumbnail;
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

        while (container && depth < MAX_HEADING_SEARCH_DEPTH) {
          const heading = container.querySelector("h1, h2, h3, h4, h5, h6");
          if (heading) {
            const headingText = heading.textContent?.trim();
            if (
              headingText &&
              headingText.length > 0 &&
              headingText.length < MAX_HEADING_TITLE_LENGTH
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
      // Extract thumbnail using unified utility (page-based search)
      const thumbnail = extractThumbnail();
      if (thumbnail) {
        metadata.thumbnail = thumbnail;
      }
    }

    return metadata;
  }
}
