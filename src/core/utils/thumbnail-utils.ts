/**
 * Thumbnail extraction utilities
 *
 * Provides unified thumbnail detection strategies that can be reused across
 * different detection handlers. Supports multiple extraction methods with
 * fallback priority:
 * 1. Video element poster attribute
 * 2. Canvas frame capture from video element
 * 3. Page selector search (meta tags, images, etc.)
 *
 * @module ThumbnailUtils
 */

const THUMBNAIL_FALLBACK_WIDTH = 320;
const THUMBNAIL_FALLBACK_HEIGHT = 180;
const THUMBNAIL_JPEG_QUALITY = 0.8;

/**
 * Extract thumbnail from video element or page
 * Uses multiple strategies with fallback priority
 *
 * @param videoElement - Optional video element for video-specific extraction
 * @returns Thumbnail URL (string) or data URL, or undefined if no thumbnail found
 */
export function extractThumbnail(
  videoElement?: HTMLVideoElement,
): string | undefined {
  // Strategy 1: Video element poster attribute
  if (videoElement?.poster) {
    return videoElement.poster;
  }

  // Strategy 2: Canvas frame capture from video element
  if (videoElement) {
    try {
      if (videoElement.readyState >= 2) {
        const canvas = document.createElement("canvas");
        canvas.width = videoElement.videoWidth || THUMBNAIL_FALLBACK_WIDTH;
        canvas.height = videoElement.videoHeight || THUMBNAIL_FALLBACK_HEIGHT;
        const ctx = canvas.getContext("2d");
        if (ctx) {
          ctx.drawImage(videoElement, 0, 0, canvas.width, canvas.height);
          return canvas.toDataURL("image/jpeg", THUMBNAIL_JPEG_QUALITY);
        }
      }
    } catch (error) {
      // CORS or other issues, ignore and fall through to next strategy
    }
  }

  // Strategy 3: Page selector search (fallback for all cases)
  return extractThumbnailFromPage();
}

/**
 * Extract thumbnail from page using common selectors
 * Searches for thumbnail images in meta tags, links, and image elements
 *
 * @returns Thumbnail URL or undefined if not found
 */
function extractThumbnailFromPage(): string | undefined {
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
        return thumbnailUrl;
      }
    }
  }

  return undefined;
}

