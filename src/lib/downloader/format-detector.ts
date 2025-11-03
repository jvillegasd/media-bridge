/**
 * Detects video format from URL or response headers
 */

import { VideoFormat } from '../types';
import { logger } from '../utils/logger';

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
      // If URL parsing fails, check if it's a blob URL or try to detect from string
      if (urlLower.includes('.m3u8')) {
        return 'hls';
      }
      if (urlLower.includes('.mpd')) {
        return 'dash';
      }
      // Default to direct for unparseable URLs that might be video
      return 'direct';
    }
    
    // Check for query parameters that indicate format
    const urlParams = urlObj.searchParams;
    if (urlParams.get('format') === 'm3u8' || urlParams.has('m3u8')) {
      return 'hls';
    }
    if (urlParams.get('format') === 'mpd' || urlParams.has('mpd')) {
      return 'dash';
    }
    
    // Check path for format indicators
    if (urlLower.includes('.m3u8') || urlLower.endsWith('.m3u8') || urlLower.includes('/hls/')) {
      return 'hls';
    }
    
    if (urlLower.includes('.mpd') || urlLower.endsWith('.mpd') || urlLower.includes('/dash/')) {
      return 'dash';
    }
    
    // Check for common video extensions
    const videoExtensions = ['.mp4', '.webm', '.ogg', '.mov', '.avi', '.mkv', '.flv', '.wmv'];
    if (videoExtensions.some(ext => urlLower.includes(ext))) {
      return 'direct';
    }
    
    // Check for YouTube URLs - these need special handling
    const hostname = urlObj.hostname.toLowerCase();
    if (hostname.includes('youtube.com') || hostname.includes('youtu.be')) {
      // YouTube watch URLs use DASH format
      // Short URLs (youtu.be) or watch URLs should be treated as needing special extraction
      if (urlObj.pathname.includes('/watch') || hostname.includes('youtu.be')) {
        return 'dash';
      }
      // For other YouTube URLs (embed, etc.), also use dash
      return 'dash';
    }
    
    // Check for Twitter/X URLs - these typically use blob URLs or direct video
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
    
    // HLS detection
    if (
      contentTypeLower.includes('application/vnd.apple.mpegurl') ||
      contentTypeLower.includes('application/x-mpegurl') ||
      contentTypeLower.includes('audio/mpegurl') ||
      contentTypeLower.includes('video/mpegurl')
    ) {
      return 'hls';
    }
    
    // DASH detection
    if (
      contentTypeLower.includes('application/dash+xml') ||
      contentTypeLower.includes('application/xml+dash')
    ) {
      return 'dash';
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
        
        // If it's text, try to read content
        if (contentType.includes('text') || contentType.includes('application') || 
            contentType.includes('xml') || contentType.includes('json')) {
          try {
            const text = await response.text();
            
            // Check for M3U8 indicators
            if (text.includes('#EXTM3U') || text.includes('#EXTINF')) {
              logger.debug('Format detected from content: HLS');
              return 'hls';
            }
            
            // Check for MPD indicators
            if (text.includes('<MPD') || text.includes('xmlns="urn:mpeg:dash') || 
                text.includes('type="dynamic"') && text.includes('DASH')) {
              logger.debug('Format detected from content: DASH');
              return 'dash';
            }
          } catch (textError) {
            logger.debug(`Could not read response as text: ${textError}`);
          }
        }
        
        // Check headers
        const formatFromHeaders = this.detectFromHeaders(contentType, url);
        if (formatFromHeaders !== 'unknown') {
          return formatFromHeaders;
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

