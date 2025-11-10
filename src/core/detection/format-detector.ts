/**
 * Detects video format from URL or response headers
 */

import { VideoFormat } from '../types';
import { logger } from '../utils/logger';
import { fetchResource } from '../utils/fetch-utils';

export class FormatDetector {
  /**
   * Detect format from URL
   */
  static detectFromUrl(url: string): VideoFormat {
    // Check URL extension
    const urlLower = url.toLowerCase();
    
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
    
    // Check for HLS playlist files (.m3u8)
    if (urlLower.includes('.m3u8') || urlLower.match(/\.m3u8(\?|$|#)/)) {
      return 'hls';
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
    if (
      contentTypeLower.includes('application/vnd.apple.mpegurl') ||
      contentTypeLower.includes('application/x-mpegurl') ||
      contentTypeLower.includes('audio/mpegurl') ||
      contentTypeLower.includes('audio/x-mpegurl')
    ) {
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
        const response = await fetchResource(url, {
          method: 'HEAD',
          mode: 'cors',
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
        const response = await fetchResource(url, {
          method: 'GET',
          headers: { Range: 'bytes=0-1024' }, // First 1KB
          mode: 'cors',
        });
        
        const contentType = response.headers.get('content-type') || '';
        
        // Check headers first
        const formatFromHeaders = this.detectFromHeaders(contentType, url);
        if (formatFromHeaders !== 'unknown') {
          return formatFromHeaders;
        }
        
        // If it's text/application, skip it
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
}

