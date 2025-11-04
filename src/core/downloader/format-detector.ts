/**
 * Detects video format from URL or response headers
 */

import { VideoFormat } from '../types';
import { logger } from '../utils/logger';
import { detectExtensionFromUrl as extractExtensionFromUrl } from '../merger/metadata-extractor';

export class FormatDetector {
  /**
   * Check if URL is an HLS segment (not a complete video file)
   * This is resilient across different video platforms (YouTube, Vimeo, Twitch, Twitter, etc.)
   */
  static isHlsSegmentUrl(url: string): boolean {
    const urlLower = url.toLowerCase();
    
    // Check for HLS segment file extensions (most reliable indicator)
    // .ts (Transport Stream) is the standard HLS segment format
    // .m4s (Media Segment) is used in CMAF/DASH-in-HLS
    // In video download context, these are almost always HLS segments
    if (urlLower.endsWith('.ts') || urlLower.endsWith('.m4s')) {
      return true;
    }
    
    // Check for HLS segment path patterns (works across platforms)
    // These patterns are common in many CDNs and streaming services
    const hlsSegmentPathPatterns = [
      '/aud/',      // Audio segments (Twitter, many CDNs)
      '/vid/',      // Video segments (Twitter, many CDNs)
      '/seg-',      // Segment prefix (common pattern)
      '/segment/',  // Segment directory
      '/chunk/',    // Chunk directory
      '/fragment/', // Fragment directory
      '/hls/',      // HLS-specific directory
    ];
    
    if (hlsSegmentPathPatterns.some(pattern => urlLower.includes(pattern))) {
      return true;
    }
    
    // Check for numeric segment patterns in filenames (platform-agnostic)
    // e.g., seg001.mp4, chunk_123.mp4, frag001.mp4
    // This catches many CDN patterns across different platforms
    if (urlLower.match(/\/seg\d+\.(mp4|ts|m4s)$/i) || // seg001.mp4, seg123.ts
        urlLower.match(/\/chunk[_\-]\d+\.(mp4|ts|m4s)$/i) || // chunk_001.mp4, chunk-123.ts
        urlLower.match(/\/frag\d+\.(mp4|ts|m4s)$/i)) { // frag001.mp4
      return true;
    }
    
    // Check for sequential numeric patterns in streaming contexts
    // e.g., /001.mp4, /002.mp4 in video/stream/media directories
    // Only match if in a streaming-related directory to avoid false positives
    if (urlLower.match(/\/\d{3,}\.(mp4|ts|m4s)$/) && 
        (urlLower.includes('/video/') || urlLower.includes('/stream/') || 
         urlLower.includes('/media/') || urlLower.includes('/hls/') ||
         urlLower.includes('/v/') || urlLower.includes('/playback/'))) {
      return true;
    }
    
    return false;
  }

  /**
   * Detect format from URL
   */
  static detectFromUrl(url: string): VideoFormat {
    // Check URL extension
    const urlLower = url.toLowerCase();
    
    // Check for HLS playlist files
    if (urlLower.includes('.m3u8') || urlLower.includes('playlist.m3u8') || urlLower.includes('master.m3u8')) {
      return 'hls';
    }
    
    // Check if this is an HLS segment URL - these should not be treated as direct videos
    if (this.isHlsSegmentUrl(url)) {
      return 'unknown'; // Don't treat HLS segments as direct videos
    }
    
    // Handle blob URLs - these are already video blobs, treat as direct
    if (url.startsWith('blob:')) {
      return 'direct';
    }
    
    // Handle data URLs - treat as direct
    if (url.startsWith('data:')) {
      return 'direct';
    }
    
    let urlObj: URL;
    try {
      urlObj = new URL(url);
    } catch (error) {
      // Default to direct for unparseable URLs that might be video
      return 'direct';
    }
    
    // Check for common video extensions
    const videoExtensions = ['.mp4', '.webm', '.ogg', '.mov', '.avi', '.mkv', '.flv', '.wmv'];
    if (videoExtensions.some(ext => urlLower.includes(ext))) {
      return 'direct';
    }
    
    // Check for Twitter/X URLs - these typically use blob URLs or direct video
    const hostname = urlObj.hostname.toLowerCase();
    if (hostname.includes('twitter.com') || hostname.includes('x.com')) {
      return 'direct';
    }
    
    // If no clear format detected but it looks like a video URL, assume direct
    // Many video CDNs don't include file extensions
    if (urlObj.pathname.match(/\/(video|stream|media|v|embed)\//i)) {
      return 'direct';
    }
    
    return 'unknown';
  }

  /**
   * Detect format from response headers
   */
  static detectFromHeaders(contentType: string, url: string): VideoFormat {
    const contentTypeLower = contentType.toLowerCase();
    
    // HLS playlist detection
    if (contentTypeLower.includes('application/vnd.apple.mpegurl') ||
        contentTypeLower.includes('application/x-mpegurl') ||
        contentTypeLower.includes('vnd.apple.mpegurl') ||
        contentTypeLower.includes('mpegurl')) {
      return 'hls';
    }
    
    // Direct video detection
    if (contentTypeLower.match(/video\/(mp4|webm|ogg|quicktime|x-msvideo|x-matroska)/)) {
      return 'direct';
    }
    
    // Fallback to URL-based detection
    return this.detectFromUrl(url);
  }

  /**
   * Detect format from response (async)
   */
  static async detectFromResponse(url: string): Promise<VideoFormat> {
    try {
      const response = await fetch(url, { 
        method: 'HEAD',
        mode: 'cors',
        signal: AbortSignal.timeout(5000),
      });
      
      const contentType = response.headers.get('content-type') || '';
      return this.detectFromHeaders(contentType, url);
    } catch (error) {
      logger.warn(`Could not detect format from response for ${url}:`, error);
      // Fallback to URL-based detection
      return this.detectFromUrl(url);
    }
  }

  /**
   * Detect format with content inspection (fetch first bytes)
   */
  static async detectWithInspection(url: string): Promise<VideoFormat> {
    try {
      // First try URL-based detection (fast, no network request)
      const urlBasedFormat = this.detectFromUrl(url);
      if (urlBasedFormat !== 'unknown') {
        logger.debug(`Format detected from URL: ${urlBasedFormat}`);
        return urlBasedFormat;
      }

      // Blob URLs and data URLs can't be fetched from service worker context
      // They should have been caught by detectFromUrl, but handle them here as well
      if (url.startsWith('blob:') || url.startsWith('data:')) {
        logger.debug('Format detected as direct for blob/data URL');
        return 'direct';
      }

      // If URL-based detection failed, try fetching headers
      try {
        const response = await fetch(url, {
          method: 'HEAD',
          mode: 'cors',
          signal: AbortSignal.timeout(5000),
        });
        
        const contentType = response.headers.get('content-type') || '';
        const formatFromHeaders = this.detectFromHeaders(contentType, url);
        
        if (formatFromHeaders !== 'unknown') {
          logger.debug(`Format detected from headers: ${formatFromHeaders}`);
          return formatFromHeaders;
        }
      } catch (headError) {
        logger.debug(`HEAD request failed, trying GET: ${headError}`);
      }

      // If HEAD failed, try GET with range request
      try {
        const response = await fetch(url, {
          method: 'GET',
          headers: { Range: 'bytes=0-1024' }, // First 1KB
          mode: 'cors',
          signal: AbortSignal.timeout(5000),
        });
        
        const contentType = response.headers.get('content-type') || '';
        
        // Check headers first (handles HLS playlists which are text/application)
        const formatFromHeaders = this.detectFromHeaders(contentType, url);
        if (formatFromHeaders !== 'unknown') {
          return formatFromHeaders;
        }
        
        // If it's text/application but not HLS, skip it
        if (contentType.includes('text') || contentType.includes('application') || 
            contentType.includes('xml') || contentType.includes('json')) {
          logger.debug('Non-video content type detected, skipping');
        }
      } catch (getError) {
        logger.debug(`GET request failed: ${getError}`);
      }
      
      // Final fallback to URL detection
      const finalFormat = this.detectFromUrl(url);
      return finalFormat !== 'unknown' ? finalFormat : 'direct'; // Default to direct if unknown
    } catch (error) {
      logger.warn(`Could not inspect content for ${url}:`, error);
      // Fallback to URL-based detection
      const urlFormat = this.detectFromUrl(url);
      return urlFormat !== 'unknown' ? urlFormat : 'direct'; // Default to direct if unknown
    }
  }

  /**
   * Extract file extension from URL
   */
  static detectExtensionFromUrl(url: string): string | undefined {
    return extractExtensionFromUrl(url);
  }
}

