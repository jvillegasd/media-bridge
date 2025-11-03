/**
 * M3U8 playlist parser for HLS streams
 */

import { HLSPlaylist, HLSVariant, SegmentInfo } from '../types';
import { resolveUrl } from '../utils/url-utils';
import { ParseError } from '../utils/errors';
import { logger } from '../utils/logger';

export class M3U8Parser {
  /**
   * Parse M3U8 playlist text
   */
  static parse(playlistText: string, baseUrl: string): HLSPlaylist {
    const lines = playlistText
      .split('\n')
      .map(l => l.trim())
      .filter(line => line.length > 0 && !line.startsWith('#EXT-X-ENDLIST') || line.startsWith('#'));
    
    const segments: SegmentInfo[] = [];
    let currentSegment: Partial<SegmentInfo> | null = null;
    let isMasterPlaylist = false;
    const variants: HLSVariant[] = [];
    let totalDuration = 0;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      
      // Master playlist variant streams
      if (line.startsWith('#EXT-X-STREAM-INF:')) {
        const nextLine = lines[i + 1];
        if (nextLine && !nextLine.startsWith('#')) {
          const variant = this.parseVariant(line, nextLine, baseUrl);
          if (variant) {
            variants.push(variant);
          }
          i++;
          isMasterPlaylist = true;
          continue;
        }
      }
      
      // I-Frame playlist
      if (line.startsWith('#EXT-X-I-FRAME-STREAM-INF:')) {
        // Parse I-frame variant (typically used for seeking)
        const variant = this.parseIFrameVariant(line, baseUrl);
        if (variant) {
          variants.push(variant);
        }
        isMasterPlaylist = true;
        continue;
      }
      
      // Segment duration
      if (line.startsWith('#EXTINF:')) {
        const durationMatch = line.match(/#EXTINF:([\d.]+)/);
        if (durationMatch) {
          const duration = parseFloat(durationMatch[1]);
          if (!currentSegment) {
            currentSegment = {};
          }
          currentSegment.duration = duration;
          totalDuration += duration;
        }
        continue;
      }
      
      // Segment URL
      if (
        line.startsWith('http://') || 
        line.startsWith('https://') || 
        line.startsWith('/') || 
        (!line.startsWith('#') && line.length > 0)
      ) {
        const url = resolveUrl(line, baseUrl);
        const sequence = segments.length;
        
        segments.push({
          url,
          sequence,
          duration: currentSegment?.duration || 0,
        });
        
        currentSegment = null;
        continue;
      }
      
      // Byte range (for sub-range requests)
      if (line.startsWith('#EXT-X-BYTERANGE:')) {
        const match = line.match(/#EXT-X-BYTERANGE:(\d+)@?(\d*)/);
        if (match && currentSegment) {
          const length = parseInt(match[1]);
          const start = match[2] ? parseInt(match[2]) : undefined;
          currentSegment.byteRange = {
            start: start || 0,
            end: (start || 0) + length,
          };
        }
        continue;
      }
      
      // Encryption/DRM info
      if (line.startsWith('#EXT-X-KEY:')) {
        logger.warn('Encrypted stream detected. May not be downloadable without decryption keys.');
      }
      
      // Discontinuity marker
      if (line.startsWith('#EXT-X-DISCONTINUITY')) {
        // Reset sequence or mark discontinuity
        continue;
      }
    }
    
    return {
      isMasterPlaylist,
      variants: isMasterPlaylist ? variants : undefined,
      segments,
      totalDuration,
      baseUrl,
    };
  }

  /**
   * Parse variant stream information
   */
  private static parseVariant(
    streamInfo: string,
    url: string,
    baseUrl: string
  ): HLSVariant | null {
    const params: Record<string, string> = {};
    
    // Extract parameters from EXT-X-STREAM-INF line
    const paramString = streamInfo.replace('#EXT-X-STREAM-INF:', '');
    
    // Parse key=value pairs
    paramString.split(',').forEach(part => {
      const trimmed = part.trim();
      const eqIndex = trimmed.indexOf('=');
      if (eqIndex > 0) {
        const key = trimmed.substring(0, eqIndex).trim();
        const value = trimmed.substring(eqIndex + 1).trim().replace(/"/g, '');
        params[key] = value;
      }
    });
    
    return {
      url: resolveUrl(url, baseUrl),
      bandwidth: parseInt(params.BANDWIDTH || '0'),
      resolution: params.RESOLUTION || undefined,
      codecs: params.CODECS || undefined,
    };
  }

  /**
   * Parse I-Frame variant
   */
  private static parseIFrameVariant(line: string, baseUrl: string): HLSVariant | null {
    const uriMatch = line.match(/URI="([^"]+)"/);
    if (!uriMatch) return null;
    
    const params: Record<string, string> = {};
    const paramString = line.replace('#EXT-X-I-FRAME-STREAM-INF:', '');
    
    paramString.split(',').forEach(part => {
      const trimmed = part.trim();
      const eqIndex = trimmed.indexOf('=');
      if (eqIndex > 0) {
        const key = trimmed.substring(0, eqIndex).trim();
        const value = trimmed.substring(eqIndex + 1).trim().replace(/"/g, '');
        params[key] = value;
      }
    });
    
    return {
      url: resolveUrl(uriMatch[1], baseUrl),
      bandwidth: parseInt(params.BANDWIDTH || '0'),
      resolution: params.RESOLUTION || undefined,
      codecs: params.CODECS || undefined,
    };
  }

  /**
   * Fetch and parse M3U8 playlist from URL
   */
  static async fetchPlaylist(url: string): Promise<HLSPlaylist> {
    try {
      const response = await fetch(url);
      
      if (!response.ok) {
        throw new ParseError(`Failed to fetch playlist: ${response.statusText}`);
      }
      
      const text = await response.text();
      
      if (!text.includes('#EXTM3U') && !text.includes('#EXTINF')) {
        throw new ParseError('Invalid M3U8 playlist format');
      }
      
      return this.parse(text, url);
    } catch (error) {
      if (error instanceof ParseError) {
        throw error;
      }
      throw new ParseError(`Failed to fetch or parse playlist: ${error}`);
    }
  }

  /**
   * Select best quality variant from master playlist
   */
  static selectBestVariant(variants: HLSVariant[]): HLSVariant {
    if (variants.length === 0) {
      throw new ParseError('No variants available');
    }
    
    // Sort by bandwidth (highest first)
    const sorted = [...variants].sort((a, b) => b.bandwidth - a.bandwidth);
    return sorted[0];
  }
}

