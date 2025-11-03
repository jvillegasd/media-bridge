/**
 * HLS video downloader
 */

import { HLSPlaylist } from '../types';
import { M3U8Parser } from '../parsers/m3u8-parser';
import { SegmentDownloader, DownloadProgress } from './segment-downloader';
import { DownloadError } from '../utils/errors';
import { logger } from '../utils/logger';

export interface HLSDownloadOptions {
  maxConcurrent?: number;
  onProgress?: (stage: string, progress?: DownloadProgress) => void;
  quality?: 'best' | 'worst' | number; // Bandwidth value
}

export class HLSDownloader {
  private maxConcurrent: number;
  private onProgress?: (stage: string, progress?: DownloadProgress) => void;
  private quality: 'best' | 'worst' | number;

  constructor(options: HLSDownloadOptions = {}) {
    this.maxConcurrent = options.maxConcurrent || 3;
    this.onProgress = options.onProgress;
    this.quality = options.quality || 'best';
  }

  /**
   * Download HLS stream
   */
  async download(m3u8Url: string): Promise<Blob[]> {
    try {
      // Fetch and parse playlist
      this.onProgress?.('parsing', undefined);
      logger.info(`Fetching HLS playlist from ${m3u8Url}`);
      
      const playlist = await M3U8Parser.fetchPlaylist(m3u8Url);
      
      // If master playlist, select variant and fetch media playlist
      if (playlist.isMasterPlaylist && playlist.variants) {
        if (playlist.variants.length === 0) {
          throw new DownloadError('No variant streams found in master playlist');
        }

        logger.info(`Master playlist detected with ${playlist.variants.length} variants`);
        
        // Select variant based on quality preference
        const selectedVariant = this.selectVariant(playlist.variants);
        logger.info(`Selected variant: ${selectedVariant.bandwidth} bps, ${selectedVariant.resolution || 'unknown resolution'}`);
        
        // Fetch the media playlist for the selected variant
        this.onProgress?.('fetching_playlist', undefined);
        const mediaPlaylist = await M3U8Parser.fetchPlaylist(selectedVariant.url);
        
        if (!mediaPlaylist.segments || mediaPlaylist.segments.length === 0) {
          throw new DownloadError('No segments found in media playlist');
        }
        
        playlist.segments = mediaPlaylist.segments;
        logger.info(`Found ${playlist.segments.length} segments in media playlist`);
      }

      if (!playlist.segments || playlist.segments.length === 0) {
        throw new DownloadError('No segments found in playlist');
      }

      // Download all segments
      this.onProgress?.('downloading', { downloaded: 0, total: playlist.segments.length, percentage: 0 });
      
      const segmentDownloader = new SegmentDownloader({
        maxConcurrent: this.maxConcurrent,
        onProgress: (progress) => {
          this.onProgress?.('downloading', progress);
        },
      });

      const segments = await segmentDownloader.downloadAll(playlist.segments);
      
      if (segments.length === 0) {
        throw new DownloadError('Failed to download any segments');
      }

      logger.info(`Successfully downloaded ${segments.length} segments`);
      
      return segments;
    } catch (error) {
      logger.error('HLS download failed:', error);
      throw error instanceof DownloadError ? error : new DownloadError(`HLS download failed: ${error}`);
    }
  }

  /**
   * Select variant based on quality preference
   */
  private selectVariant(variants: Array<{ bandwidth: number; resolution?: string; url: string }>) {
    const sorted = [...variants].sort((a, b) => b.bandwidth - a.bandwidth);

    if (this.quality === 'best') {
      return sorted[0];
    } else if (this.quality === 'worst') {
      return sorted[sorted.length - 1];
    } else {
      // Select closest bandwidth
      const targetBandwidth = this.quality;
      return sorted.reduce((prev, curr) => {
        const prevDiff = Math.abs(prev.bandwidth - targetBandwidth);
        const currDiff = Math.abs(curr.bandwidth - targetBandwidth);
        return currDiff < prevDiff ? curr : prev;
      });
    }
  }
}

