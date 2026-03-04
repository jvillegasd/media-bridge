/**
 * DASH detection handler
 *
 * Detects MPEG-DASH streams from network requests by recognizing .mpd URLs,
 * fetching the manifest, and extracting metadata including DRM status and
 * live/VOD distinction.
 *
 * Mirrors HlsDetectionHandler in structure and deduplication strategy.
 */

import { VideoMetadata, VideoFormat } from "../../types";
import { fetchText } from "../../utils/fetch-utils";
import { normalizeUrl } from "../../utils/url-utils";
import { logger } from "../../utils/logger";
import { extractThumbnail } from "../thumbnail-utils";
import { isLive, hasDrm } from "../../parsers/mpd-parser";
import { DEFAULT_DETECTION_CACHE_SIZE } from "../../../shared/constants";

export interface DashDetectionHandlerOptions {
  onVideoDetected?: (video: VideoMetadata) => void;
  /** Max distinct URL path keys tracked per page (default: 500) */
  detectionCacheSize?: number;
}

/**
 * DASH detection handler — detects .mpd manifest URLs
 */
export class DashDetectionHandler {
  private onVideoDetected?: (video: VideoMetadata) => void;
  private seenPathKeys: Set<string> = new Set();
  private readonly maxSeenPathKeys: number;

  constructor(options: DashDetectionHandlerOptions = {}) {
    this.onVideoDetected = options.onVideoDetected;
    this.maxSeenPathKeys = options.detectionCacheSize ?? DEFAULT_DETECTION_CACHE_SIZE;
  }

  destroy(): void {
    this.seenPathKeys.clear();
  }

  handleNetworkRequest(url: string): void {
    if (this.isDashUrl(url)) {
      this.detect(url);
    }
  }

  async detect(url: string): Promise<VideoMetadata | null> {
    if (!this.isDashUrl(url)) return null;

    // Deduplicate by origin+pathname — ignores auth tokens in query params
    const pathKey = this.getPathKey(url);
    if (this.seenPathKeys.has(pathKey)) return null;
    if (this.seenPathKeys.size >= this.maxSeenPathKeys) {
      const first = this.seenPathKeys.values().next().value;
      if (first) this.seenPathKeys.delete(first);
    }
    this.seenPathKeys.add(pathKey);

    try {
      const mpdText = await fetchText(url, 1);
      const metadata = this.extractMetadata(url, mpdText);
      if (metadata && this.onVideoDetected) {
        this.onVideoDetected(metadata);
      }
      return metadata;
    } catch (error) {
      logger.error("[Media Bridge] Failed to fetch DASH manifest:", error);
      return null;
    }
  }

  private isDashUrl(url: string): boolean {
    try {
      const pathname = new URL(url).pathname.toLowerCase();
      return pathname.endsWith(".mpd");
    } catch {
      return url.toLowerCase().includes(".mpd");
    }
  }

  private getPathKey(url: string): string {
    try {
      const u = new URL(url);
      return u.origin + u.pathname;
    } catch {
      return url;
    }
  }

  private extractMetadata(url: string, mpdText: string): VideoMetadata {
    const drm = hasDrm(mpdText);
    const live = isLive(mpdText);

    const metadata: VideoMetadata = {
      url,
      format: VideoFormat.DASH,
      pageUrl: window.location.href,
      title: document.title,
      fileExtension: "mpd",
      hasDrm: drm,
      unsupported: drm, // DRM-protected DASH cannot be downloaded
      isLive: live,
    };

    const thumbnail = extractThumbnail();
    if (thumbnail) metadata.thumbnail = thumbnail;

    return metadata;
  }

  /** Check whether a Content-Type header indicates a DASH manifest */
  isDashContentType(contentType: string): boolean {
    return contentType.toLowerCase().includes("application/dash+xml");
  }

  /** Normalize URL for deduplication — removes hash fragment */
  normalizeUrl(url: string): string {
    return normalizeUrl(url);
  }
}
