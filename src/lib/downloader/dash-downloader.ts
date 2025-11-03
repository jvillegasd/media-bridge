/**
 * DASH/MPD video downloader
 */

import { DASHManifest, DASHRepresentation } from '../types';
import { MPDParser } from '../parsers/mpd-parser';
import { SegmentDownloader, DownloadProgress } from './segment-downloader';
import { DownloadError } from '../utils/errors';
import { logger } from '../utils/logger';

export interface DASHDownloadOptions {
  maxConcurrent?: number;
  onProgress?: (stage: string, stream?: 'video' | 'audio', progress?: DownloadProgress) => void;
  quality?: 'best' | 'worst' | number; // Bandwidth value
}

export interface DASHDownloadResult {
  video: {
    init?: Blob;
    segments: Blob[];
  };
  audio?: {
    init?: Blob;
    segments: Blob[];
  };
}

export class DASHDownloader {
  private maxConcurrent: number;
  private onProgress?: (stage: string, stream?: 'video' | 'audio', progress?: DownloadProgress) => void;
  private quality: 'best' | 'worst' | number;

  constructor(options: DASHDownloadOptions = {}) {
    this.maxConcurrent = options.maxConcurrent || 3;
    this.onProgress = options.onProgress;
    this.quality = options.quality || 'best';
  }

  /**
   * Download DASH stream
   */
  async download(mpdUrl: string): Promise<DASHDownloadResult> {
    try {
      // Check if this is a YouTube URL - YouTube doesn't use standard MPD files
      const urlObj = new URL(mpdUrl);
      if (urlObj.hostname.includes('youtube.com') || urlObj.hostname.includes('youtu.be')) {
        throw new DownloadError(
          'YouTube URLs require special handling. YouTube uses adaptive formats, not standard MPD manifests. ' +
          'Please use the extension popup on the YouTube video page to download videos.'
        );
      }
      
      // Parse MPD manifest
      this.onProgress?.('parsing', undefined);
      logger.info(`Fetching DASH manifest from ${mpdUrl}`);
      
      const manifest = await MPDParser.parse(mpdUrl);
      
      if (!manifest.video || manifest.video.length === 0) {
        throw new DownloadError('No video representations found in MPD');
      }

      logger.info(`Found ${manifest.video.length} video representations and ${manifest.audio?.length || 0} audio representations`);

      // Select best quality representations
      const selectedVideo = this.selectRepresentation(manifest.video);
      const selectedAudio = manifest.audio ? this.selectRepresentation(manifest.audio) : undefined;

      logger.info(`Selected video: ${selectedVideo.bandwidth} bps, ${selectedVideo.width}x${selectedVideo.height || '?'}`);
      if (selectedAudio) {
        logger.info(`Selected audio: ${selectedAudio.bandwidth} bps`);
      }

      // Download video segments
      const videoSegments = await this.downloadRepresentation(
        selectedVideo,
        'video'
      );

      // Download audio segments (if available)
      let audioSegments;
      if (selectedAudio) {
        audioSegments = await this.downloadRepresentation(
          selectedAudio,
          'audio'
        );
      }

      return {
        video: videoSegments,
        audio: audioSegments,
      };
    } catch (error) {
      logger.error('DASH download failed:', error);
      throw error instanceof DownloadError ? error : new DownloadError(`DASH download failed: ${error}`);
    }
  }

  /**
   * Download a representation (video or audio)
   */
  private async downloadRepresentation(
    representation: DASHRepresentation,
    streamType: 'video' | 'audio'
  ): Promise<{ init?: Blob; segments: Blob[] }> {
    const { segments: segmentInfo } = representation;
    
    if (!segmentInfo.segments || segmentInfo.segments.length === 0) {
      throw new DownloadError(`No segments found for ${streamType} representation`);
    }

    logger.info(`Downloading ${streamType}: ${segmentInfo.segments.length} segments`);

    const segmentDownloader = new SegmentDownloader({
      maxConcurrent: this.maxConcurrent,
      onProgress: (progress) => {
        this.onProgress?.('downloading', streamType, progress);
      },
    });

    // Download initialization segment if present
    let initBlob: Blob | undefined;
    if (segmentInfo.initUrl) {
      this.onProgress?.('downloading', streamType, {
        downloaded: 0,
        total: segmentInfo.segments.length + 1,
        percentage: 0,
      });
      
      try {
        initBlob = await segmentDownloader.downloadSegment({
          url: segmentInfo.initUrl,
          sequence: -1,
        });
        logger.debug(`Downloaded ${streamType} init segment`);
      } catch (error) {
        logger.warn(`Failed to download ${streamType} init segment:`, error);
        // Continue without init segment (some players can work without it)
      }
    }

    // Download media segments
    const mediaBlobs = await segmentDownloader.downloadAll(segmentInfo.segments);

    if (mediaBlobs.length === 0) {
      throw new DownloadError(`Failed to download any ${streamType} segments`);
    }

    logger.info(`Successfully downloaded ${mediaBlobs.length} ${streamType} segments`);

    return {
      init: initBlob,
      segments: mediaBlobs,
    };
  }

  /**
   * Select representation based on quality preference
   */
  private selectRepresentation(representations: DASHRepresentation[]): DASHRepresentation {
    // Representations are already sorted by bandwidth (highest first) from parser
    if (this.quality === 'best') {
      return representations[0];
    } else if (this.quality === 'worst') {
      return representations[representations.length - 1];
    } else {
      // Select closest bandwidth
      const targetBandwidth = this.quality;
      return representations.reduce((prev, curr) => {
        const prevDiff = Math.abs(prev.bandwidth - targetBandwidth);
        const currDiff = Math.abs(curr.bandwidth - targetBandwidth);
        return currDiff < prevDiff ? curr : prev;
      });
    }
  }
}

