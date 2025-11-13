/**
 * URL utility functions
 */

import { VideoFormat } from '../types';

/**
 * Normalize URL by removing hash fragments and trailing slashes
 * Hash fragments don't affect the actual resource being downloaded
 */
export function normalizeUrl(url: string): string {
  try {
    const urlObj = new URL(url);
    // Remove hash fragment (it doesn't affect the downloaded content)
    urlObj.hash = '';
    return urlObj.href;
  } catch {
    // If URL parsing fails, just remove hash manually
    const hashIndex = url.indexOf('#');
    return hashIndex >= 0 ? url.substring(0, hashIndex) : url;
  }
}

/**
 * Detect video format from URL
 */
export function detectFormatFromUrl(url: string): VideoFormat {
  // Check URL extension
  const urlLower = url.toLowerCase();

  // Handle blob URLs - these are already video blobs, treat as direct
  if (url.startsWith("blob:")) {
    return "direct";
  }

  // Handle data URLs - treat as direct
  if (url.startsWith("data:")) {
    return "direct";
  }

  let urlObj: URL;
  try {
    urlObj = new URL(url);
  } catch (error) {
    return "unknown";
  }

  // Check for HLS playlist files (.m3u8)
  if (urlLower.includes(".m3u8") || urlLower.match(/\.m3u8(\?|$|#)/)) {
    return "hls";
  }

  // Check for common video extensions
  const videoExtensions = [
    ".mp4",
    ".webm",
    ".ogg",
    ".mov",
    ".avi",
    ".mkv",
    ".flv",
    ".wmv",
  ];
  if (videoExtensions.some((ext) => urlLower.includes(ext))) {
    return "direct";
  }

  // If no clear format detected but it looks like a video URL, assume direct
  // Many video CDNs don't include file extensions
  if (urlObj.pathname.match(/\/(video|stream|media|v|embed)\//i)) {
    return "direct";
  }

  return "unknown";
}

