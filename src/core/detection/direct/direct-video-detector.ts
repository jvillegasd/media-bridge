/**
 * Direct video detector - low-level direct video detection logic
 */

import { VideoMetadata } from '../../types';
import { FormatDetector } from '../format-detector';

export class DirectVideoDetector {
  /**
   * Check if URL is a direct video URL
   */
  isDirectVideoUrl(url: string): boolean {
    return (
      url.includes('.mp4') ||
      url.includes('.webm') ||
      url.includes('.mov') ||
      url.includes('.avi') ||
      url.includes('.mkv') ||
      url.includes('.flv') ||
      url.includes('.wmv') ||
      url.includes('.ogg')
    );
  }

  /**
   * Check if URL is audio-only (not a video track)
   */
  isAudioOnlyUrl(url: string): boolean {
    const lowerUrl = url.toLowerCase();
    
    const audioPatterns = [
      '/aud/',
      '/audio/',
      '/mp4a/',
      '/aac/',
      '/audio_track',
      '/sound/',
    ];
    
    if (audioPatterns.some(pattern => lowerUrl.includes(pattern))) {
      return true;
    }
    
    // For Twitter/X amplify_video URLs
    if (lowerUrl.includes('amplify_video')) {
      if (lowerUrl.includes('/aud/')) {
        return true;
      }
      if (lowerUrl.includes('/vid/') || lowerUrl.includes('/video/')) {
        return false;
      }
    }
    
    return false;
  }

  /**
   * Extract metadata from direct video URL
   */
  async extractMetadata(
    url: string,
    videoElement?: HTMLVideoElement,
  ): Promise<VideoMetadata | null> {
    const rawFormat = FormatDetector.detectFromUrl(url);
    const format = rawFormat === 'unknown' ? 'direct' : rawFormat;
    
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
            element.getAttribute('content') ||
            element.getAttribute('href') ||
            (element as HTMLImageElement).src;
          if (thumbnailUrl) {
            metadata.thumbnail = thumbnailUrl;
            break;
          }
        }
      }

      // Check for YouTube thumbnail pattern
      if (url.includes('youtube.com') || url.includes('youtu.be')) {
        const videoId = this.extractYouTubeVideoId(url);
        if (videoId) {
          metadata.thumbnail = `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`;
        }
      }
    }

    return metadata;
  }

  /**
   * Extract YouTube video ID from URL
   */
  private extractYouTubeVideoId(url: string): string | null {
    const patterns = [
      /(?:youtube\.com\/watch\?v=|youtu\.be\/)([^&\n?#]+)/,
      /youtube\.com\/embed\/([^&\n?#]+)/,
    ];

    for (const pattern of patterns) {
      const match = url.match(pattern);
      if (match && match[1]) {
        return match[1];
      }
    }

    return null;
  }
}

