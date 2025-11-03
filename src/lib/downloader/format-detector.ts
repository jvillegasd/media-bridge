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
    
    if (urlLower.includes('.m3u8') || urlLower.endsWith('.m3u8')) {
      return 'hls';
    }
    
    if (urlLower.includes('.mpd') || urlLower.endsWith('.mpd')) {
      return 'dash';
    }
    
    // Check for common video extensions
    const videoExtensions = ['.mp4', '.webm', '.ogg', '.mov', '.avi', '.mkv'];
    if (videoExtensions.some(ext => urlLower.includes(ext))) {
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
      const response = await fetch(url, {
        method: 'GET',
        headers: { Range: 'bytes=0-1024' }, // First 1KB
        mode: 'cors',
        signal: AbortSignal.timeout(5000),
      });
      
      const contentType = response.headers.get('content-type') || '';
      
      // If it's text, try to read content
      if (contentType.includes('text') || contentType.includes('application')) {
        const text = await response.text();
        
        // Check for M3U8 indicators
        if (text.includes('#EXTM3U') || text.includes('#EXTINF')) {
          return 'hls';
        }
        
        // Check for MPD indicators
        if (text.includes('<MPD') || text.includes('xmlns="urn:mpeg:dash')) {
          return 'dash';
        }
      }
      
      return this.detectFromHeaders(contentType, url);
    } catch (error) {
      logger.warn(`Could not inspect content for ${url}:`, error);
      return this.detectFromUrl(url);
    }
  }
}

