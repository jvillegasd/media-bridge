/**
 * HLS video detector - low-level HLS playlist detection logic
 */

import { VideoMetadata } from '../../types';

export class HlsVideoDetector {
  /**
   * Check if URL is an HLS playlist URL
   */
  isHlsUrl(url: string): boolean {
    const urlLower = url.toLowerCase();
    return urlLower.includes('.m3u8') || !!urlLower.match(/\.m3u8(\?|$|#)/);
  }

  /**
   * Check if content type indicates HLS playlist
   */
  isHlsContentType(contentType: string): boolean {
    const contentTypeLower = contentType.toLowerCase();
    return (
      contentTypeLower.includes('application/vnd.apple.mpegurl') ||
      contentTypeLower.includes('application/x-mpegurl')
    );
  }

  /**
   * Extract metadata from HLS playlist URL
   */
  async extractMetadata(url: string): Promise<VideoMetadata | null> {
    const metadata: VideoMetadata = {
      url,
      format: 'hls',
      pageUrl: window.location.href,
      title: document.title,
      fileExtension: 'm3u8',
    };

    // Try to find thumbnail in page
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
          element.getAttribute('content') ||
          element.getAttribute('href') ||
          (element as HTMLImageElement).src;
        if (thumbnailUrl) {
          metadata.thumbnail = thumbnailUrl;
          break;
        }
      }
    }

    // Try to find a more specific title from the page
    const ogTitle = document.querySelector('meta[property="og:title"]');
    if (ogTitle) {
      const ogTitleContent = (ogTitle as HTMLMetaElement).content?.trim();
      if (ogTitleContent && ogTitleContent.length > 0) {
        metadata.title = ogTitleContent;
      }
    }

    return metadata;
  }
}

