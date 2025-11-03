/**
 * Unified segment merger interface
 */

import { FFmpegMerger, MergeProgress } from './ffmpeg-merger';
import { MergeError } from '../utils/errors';
import { logger } from '../utils/logger';
import { DASHDownloadResult } from '../downloader/dash-downloader';

export interface MergeOptions {
  onProgress?: (progress: MergeProgress) => void;
  outputFilename?: string;
}

export class SegmentMerger {
  private ffmpegMerger: FFmpegMerger;

  constructor(options: MergeOptions = {}) {
    this.ffmpegMerger = new FFmpegMerger(options.onProgress);
  }

  /**
   * Merge HLS segments
   */
  async mergeHLS(segments: Blob[], options: MergeOptions = {}): Promise<Blob> {
    try {
      if (!this.ffmpegMerger) {
        this.ffmpegMerger = new FFmpegMerger(options.onProgress);
      }

      const outputFilename = options.outputFilename || 'merged_hls.mp4';
      return await this.ffmpegMerger.mergeHLS(segments, outputFilename);
    } catch (error) {
      logger.error('HLS merge failed:', error);
      throw error instanceof MergeError ? error : new MergeError(`HLS merge failed: ${error}`);
    }
  }

  /**
   * Mux DASH video and audio
   */
  async mergeDASH(dashResult: DASHDownloadResult, options: MergeOptions = {}): Promise<Blob> {
    try {
      if (!this.ffmpegMerger) {
        this.ffmpegMerger = new FFmpegMerger(options.onProgress);
      }

      const outputFilename = options.outputFilename || 'merged_dash.mp4';

      // Handle initialization segments
      let videoSegments = dashResult.video.segments;
      if (dashResult.video.init) {
        // Prepend init segment
        videoSegments = [dashResult.video.init, ...dashResult.video.segments];
      }

      let audioSegments: Blob[] | undefined;
      if (dashResult.audio) {
        audioSegments = dashResult.audio.segments;
        if (dashResult.audio.init) {
          // Prepend init segment
          audioSegments = [dashResult.audio.init, ...dashResult.audio.segments];
        }
      }

      return await this.ffmpegMerger.muxDASH(videoSegments, audioSegments, outputFilename);
    } catch (error) {
      logger.error('DASH merge failed:', error);
      throw error instanceof MergeError ? error : new MergeError(`DASH merge failed: ${error}`);
    }
  }

  /**
   * Initialize merger (load FFmpeg)
   */
  async initialize(): Promise<void> {
    if (this.ffmpegMerger) {
      await this.ffmpegMerger.initialize();
    }
  }

  /**
   * Dispose of merger resources
   */
  async dispose(): Promise<void> {
    if (this.ffmpegMerger) {
      await this.ffmpegMerger.dispose();
    }
  }
}

