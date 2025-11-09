/**
 * HLS video detector - low-level HLS playlist detection logic
 */

import { VideoMetadata } from '../../types';
import { v4 as uuidv4 } from 'uuid';

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
  async extractMetadata(
    url: string,
    videoElement?: HTMLVideoElement,
  ): Promise<VideoMetadata | null> {
    const metadata: VideoMetadata = {
      url,
      format: 'hls',
      pageUrl: window.location.href,
      videoId: uuidv4(),
      title: document.title,
      fileExtension: 'm3u8',
    };

    // Extract metadata from video element if available
    if (videoElement) {
      metadata.width = videoElement.videoWidth || undefined;
      metadata.height = videoElement.videoHeight || undefined;
      metadata.duration = videoElement.duration || undefined;

      if (metadata.width && metadata.height) {
        const height = metadata.height;
        if (height >= 2160) {
          metadata.resolution = '4K';
        } else if (height >= 1440) {
          metadata.resolution = '1440p';
        } else if (height >= 1080) {
          metadata.resolution = '1080p';
        } else if (height >= 720) {
          metadata.resolution = '720p';
        } else if (height >= 480) {
          metadata.resolution = '480p';
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
            const canvas = document.createElement('canvas');
            canvas.width = videoElement.videoWidth || 320;
            canvas.height = videoElement.videoHeight || 180;
            const ctx = canvas.getContext('2d');
            if (ctx) {
              ctx.drawImage(videoElement, 0, 0, canvas.width, canvas.height);
              metadata.thumbnail = canvas.toDataURL('image/jpeg', 0.8);
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
        metadata.title.includes(' - ') ||
        metadata.title.includes(' / ')
      ) {
        let container = videoElement.parentElement;
        let depth = 0;

        while (container && depth < 3) {
          const heading = container.querySelector('h1, h2, h3, h4, h5, h6');
          if (heading) {
            const headingText = heading.textContent?.trim();
            if (headingText && headingText.length > 0 && headingText.length < 200) {
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
          metadata.title = videoElement.getAttribute('title') || document.title;
        }
      }
    } else {
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
    }

    return metadata;
  }
}

