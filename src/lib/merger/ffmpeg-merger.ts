/**
 * FFmpeg.wasm integration for segment merging
 */

import { FFmpeg } from '@ffmpeg/ffmpeg';
import { MergeError } from '../utils/errors';
import { logger } from '../utils/logger';

export interface MergeProgress {
  percentage: number;
  message?: string;
}

export class FFmpegMerger {
  private ffmpeg: FFmpeg;
  private initialized: boolean = false;
  private onProgress?: (progress: MergeProgress) => void;

  constructor(onProgress?: (progress: MergeProgress) => void) {
    this.ffmpeg = new FFmpeg();
    this.onProgress = onProgress;
    this.setupProgressCallback();
  }

  /**
   * Initialize FFmpeg
   */
  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    try {
      logger.info('Initializing FFmpeg...');
      
      // Set up log callback
      this.ffmpeg.on('log', ({ message }) => {
        logger.debug('FFmpeg:', message);
      });

      await this.ffmpeg.load();
      this.initialized = true;
      logger.info('FFmpeg initialized successfully');
    } catch (error) {
      logger.error('Failed to initialize FFmpeg:', error);
      throw new MergeError(`Failed to initialize FFmpeg: ${error}`);
    }
  }

  /**
   * Setup progress callback
   */
  private setupProgressCallback(): void {
    this.ffmpeg.on('progress', ({ progress, time }) => {
      if (this.onProgress) {
        this.onProgress({
          percentage: progress * 100,
          message: `Processing... ${time}ms`,
        });
      }
    });
  }

  /**
   * Write blob to FFmpeg filesystem
   */
  private async writeFile(filename: string, blob: Blob): Promise<void> {
    const data = await blob.arrayBuffer();
    await this.ffmpeg.writeFile(filename, new Uint8Array(data));
  }

  /**
   * Read file from FFmpeg filesystem as blob
   */
  private async readFile(filename: string): Promise<Blob> {
    const data = await this.ffmpeg.readFile(filename);
    // FFmpeg returns Uint8Array (FileData type)
    // Convert to ArrayBuffer by copying the data to ensure compatibility
    if (data instanceof Uint8Array) {
      // Create a copy to ensure we have a regular ArrayBuffer (not SharedArrayBuffer)
      const arrayBuffer = new Uint8Array(data).buffer;
      return new Blob([arrayBuffer], { type: 'video/mp4' });
    } else {
      // Fallback: treat as Uint8Array and convert
      const uint8Array = data as unknown as Uint8Array;
      const arrayBuffer = new Uint8Array(uint8Array).buffer;
      return new Blob([arrayBuffer], { type: 'video/mp4' });
    }
  }

  /**
   * Merge HLS segments (TS files) into MP4
   */
  async mergeHLS(segments: Blob[], outputFilename: string = 'output.mp4'): Promise<Blob> {
    if (!this.initialized) {
      await this.initialize();
    }

    try {
      logger.info(`Merging ${segments.length} HLS segments...`);

      // Write segments to FFmpeg filesystem
      const segmentFiles: string[] = [];
      for (let i = 0; i < segments.length; i++) {
        const filename = `segment_${i}.ts`;
        await this.writeFile(filename, segments[i]);
        segmentFiles.push(filename);
      }

      // Create concat file list
      const concatContent = segmentFiles.map(f => `file '${f}'`).join('\n');
      await this.ffmpeg.writeFile('concat.txt', concatContent);

      // Run FFmpeg to merge segments
      await this.ffmpeg.exec([
        '-f', 'concat',
        '-safe', '0',
        '-i', 'concat.txt',
        '-c', 'copy',
        '-y',
        outputFilename,
      ]);

      // Read merged file
      const mergedBlob = await this.readFile(outputFilename);

      // Cleanup
      await this.cleanupFiles([...segmentFiles, 'concat.txt', outputFilename]);

      logger.info(`Successfully merged ${segments.length} segments into ${mergedBlob.size} bytes`);
      return mergedBlob;
    } catch (error) {
      logger.error('HLS merge failed:', error);
      throw new MergeError(`Failed to merge HLS segments: ${error}`);
    }
  }

  /**
   * Mux DASH video and audio segments into MP4
   */
  async muxDASH(
    videoSegments: Blob[],
    audioSegments: Blob[] | undefined,
    outputFilename: string = 'output.mp4'
  ): Promise<Blob> {
    if (!this.initialized) {
      await this.initialize();
    }

    try {
      logger.info(`Muxing DASH: ${videoSegments.length} video segments, ${audioSegments?.length || 0} audio segments`);

      // Write video segments
      const videoFiles: string[] = [];
      for (let i = 0; i < videoSegments.length; i++) {
        const filename = `video_${i}.m4s`;
        await this.writeFile(filename, videoSegments[i]);
        videoFiles.push(filename);
      }

      // Write audio segments if available
      let audioFiles: string[] = [];
      if (audioSegments && audioSegments.length > 0) {
        for (let i = 0; i < audioSegments.length; i++) {
          const filename = `audio_${i}.m4s`;
          await this.writeFile(filename, audioSegments[i]);
          audioFiles.push(filename);
        }
      }

      // Create concat files
      const videoConcatContent = videoFiles.map(f => `file '${f}'`).join('\n');
      await this.ffmpeg.writeFile('video_concat.txt', videoConcatContent);

      if (audioFiles.length > 0) {
        const audioConcatContent = audioFiles.map(f => `file '${f}'`).join('\n');
        await this.ffmpeg.writeFile('audio_concat.txt', audioConcatContent);
      }

      // Build FFmpeg command
      const command: string[] = [];

      // Concatenate video segments
      command.push(
        '-f', 'concat',
        '-safe', '0',
        '-i', 'video_concat.txt',
      );

      // Concatenate audio segments if available
      if (audioFiles.length > 0) {
        command.push(
          '-f', 'concat',
          '-safe', '0',
          '-i', 'audio_concat.txt',
        );
      }

      // Mux and output
      command.push(
        '-c:v', 'copy',
        '-c:a', audioFiles.length > 0 ? 'copy' : 'an',
        '-y',
        outputFilename,
      );

      await this.ffmpeg.exec(command);

      // Read merged file
      const mergedBlob = await this.readFile(outputFilename);

      // Cleanup
      const cleanupFiles = [
        ...videoFiles,
        ...audioFiles,
        'video_concat.txt',
        ...(audioFiles.length > 0 ? ['audio_concat.txt'] : []),
        outputFilename,
      ];
      await this.cleanupFiles(cleanupFiles);

      logger.info(`Successfully muxed DASH into ${mergedBlob.size} bytes`);
      return mergedBlob;
    } catch (error) {
      logger.error('DASH muxing failed:', error);
      throw new MergeError(`Failed to mux DASH segments: ${error}`);
    }
  }

  /**
   * Cleanup temporary files from FFmpeg filesystem
   */
  private async cleanupFiles(filenames: string[]): Promise<void> {
    for (const filename of filenames) {
      try {
        await this.ffmpeg.deleteFile(filename);
      } catch (error) {
        logger.warn(`Failed to delete file ${filename}:`, error);
      }
    }
  }

  /**
   * Convert blob to file format if needed
   */
  async convertFormat(inputBlob: Blob, outputFormat: string, outputFilename: string): Promise<Blob> {
    if (!this.initialized) {
      await this.initialize();
    }

    try {
      const inputFilename = `input.${inputBlob.type.split('/')[1] || 'mp4'}`;
      await this.writeFile(inputFilename, inputBlob);

      await this.ffmpeg.exec([
        '-i', inputFilename,
        '-c', 'copy',
        '-y',
        outputFilename,
      ]);

      const outputBlob = await this.readFile(outputFilename);
      await this.cleanupFiles([inputFilename, outputFilename]);

      return outputBlob;
    } catch (error) {
      logger.error('Format conversion failed:', error);
      throw new MergeError(`Failed to convert format: ${error}`);
    }
  }

  /**
   * Dispose of FFmpeg instance
   */
  async dispose(): Promise<void> {
    try {
      if (this.initialized) {
        // FFmpeg.wasm doesn't have explicit dispose, but we can clear files
        logger.debug('Disposing FFmpeg merger');
        this.initialized = false;
      }
    } catch (error) {
      logger.warn('Error disposing FFmpeg:', error);
    }
  }
}

