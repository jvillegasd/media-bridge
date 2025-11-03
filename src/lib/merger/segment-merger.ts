/**
 * Unified segment merger interface
 */

import { DirectFFmpegMerger, MergeProgress } from './direct-ffmpeg-merger';
import { MergeError } from '../utils/errors';
import { logger } from '../utils/logger';
import { DASHDownloadResult } from '../downloader/dash-downloader';

export interface MergeOptions {
  onProgress?: (progress: MergeProgress) => void;
  outputFilename?: string;
}

export class SegmentMerger {
  private merger: DirectFFmpegMerger;

  constructor(options: MergeOptions = {}) {
    this.merger = new DirectFFmpegMerger(options.onProgress);
  }

  /**
   * Merge HLS segments
   */
  async mergeHLS(segments: Blob[], options: MergeOptions = {}): Promise<Blob> {
    try {
      if (!this.merger) {
        this.merger = new DirectFFmpegMerger(options.onProgress);
      }

      const outputFilename = options.outputFilename || 'merged_hls.mp4';
      return await this.merger.mergeHLS(segments, outputFilename);
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
      if (!this.merger) {
        this.merger = new DirectFFmpegMerger(options.onProgress);
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

      return await this.merger.muxDASH(videoSegments, audioSegments, outputFilename);
    } catch (error) {
      logger.error('DASH merge failed:', error);
      throw error instanceof MergeError ? error : new MergeError(`DASH merge failed: ${error}`);
    }
  }

  /**
   * Initialize merger
   */
  async initialize(): Promise<void> {
    if (this.merger) {
      await this.merger.initialize();
    }
  }

  /**
   * Dispose of merger resources
   */
  async dispose(): Promise<void> {
    if (this.merger) {
      await this.merger.dispose();
    }
  }
}

