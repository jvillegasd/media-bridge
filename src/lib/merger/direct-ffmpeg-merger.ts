/**
 * Direct FFmpeg.wasm integration using bundled binaries
 * Works with the files in public/ffmpeg/ without npm packages
 */

import { MergeError } from '../utils/errors';
import { logger } from '../utils/logger';

export interface MergeProgress {
  percentage: number;
  message?: string;
}

enum FFMessageType {
  LOAD = 'LOAD',
  EXEC = 'EXEC',
  WRITE_FILE = 'WRITE_FILE',
  READ_FILE = 'READ_FILE',
  DELETE_FILE = 'DELETE_FILE',
  LIST_DIR = 'LIST_DIR',
  ERROR = 'ERROR',
  LOG = 'LOG',
  PROGRESS = 'PROGRESS',
}

interface FFMessage {
  id: string;
  type: FFMessageType;
  data: any;
}

export class DirectFFmpegMerger {
  private worker: Worker | null = null;
  private messageId = 0;
  private pendingMessages = new Map<string, { resolve: (data: any) => void; reject: (error: any) => void }>();
  private initialized = false;
  private onProgress?: (progress: MergeProgress) => void;
  private ffmpegLogs: string[] = [];

  constructor(onProgress?: (progress: MergeProgress) => void) {
    this.onProgress = onProgress;
  }

  /**
   * Initialize FFmpeg by creating the worker and loading the core
   */
  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    try {
      logger.info('Initializing FFmpeg with bundled binaries...');

      // Get the worker URL from bundled assets
      const workerURL = chrome.runtime.getURL('ffmpeg/ffmpeg-worker.js');
      const coreURL = chrome.runtime.getURL('ffmpeg/ffmpeg-core.js');
      const wasmURL = chrome.runtime.getURL('ffmpeg/ffmpeg-core.wasm');

      logger.info(`Worker URL: ${workerURL}`);
      logger.info(`Core URL: ${coreURL}`);
      logger.info(`WASM URL: ${wasmURL}`);

      // Create the worker
      this.worker = new Worker(workerURL, { type: 'module' });

      // Set up message handler
      this.worker.onmessage = this.handleWorkerMessage.bind(this);
      this.worker.onerror = (error) => {
        logger.error('Worker error:', error);
      };

      // Load FFmpeg core
      await this.sendMessage(FFMessageType.LOAD, {
        coreURL,
        wasmURL,
      });

      this.initialized = true;
      logger.info('FFmpeg initialized successfully');
    } catch (error) {
      logger.error('Failed to initialize FFmpeg:', error);
      throw new MergeError(`Failed to initialize FFmpeg: ${error}`);
    }
  }

  /**
   * Handle messages from the worker
   */
  private handleWorkerMessage(event: MessageEvent<FFMessage>): void {
    const { id, type, data } = event.data;

    if (type === FFMessageType.LOG) {
      const logMessage = typeof data === 'string' ? data : data.message || String(data);
      this.ffmpegLogs.push(logMessage);
      logger.debug('FFmpeg log:', logMessage);
      return;
    }

    if (type === FFMessageType.PROGRESS) {
      if (this.onProgress && data.progress !== undefined) {
        this.onProgress({
          percentage: data.progress * 100,
          message: `Processing... ${data.time || ''}`,
        });
      }
      return;
    }

    if (type === FFMessageType.ERROR) {
      logger.error('FFmpeg worker error:', data);
      const pending = this.pendingMessages.get(id);
      if (pending) {
        pending.reject(new Error(data));
        this.pendingMessages.delete(id);
      }
      return;
    }

    const pending = this.pendingMessages.get(id);
    if (pending) {
      logger.debug(`Received response for message ${id}:`, type);
      pending.resolve(data);
      this.pendingMessages.delete(id);
    } else {
      logger.warn(`Received message ${id} but no pending promise found`);
    }
  }

  /**
   * Send a message to the worker and wait for response
   */
  private sendMessage(type: FFMessageType, data: any): Promise<any> {
    return new Promise((resolve, reject) => {
      if (!this.worker) {
        reject(new Error('Worker not initialized'));
        return;
      }

      const id = `msg_${this.messageId++}`;
      this.pendingMessages.set(id, { resolve, reject });

      this.worker.postMessage({ id, type, data });

      // Timeout after 5 minutes
      setTimeout(() => {
        if (this.pendingMessages.has(id)) {
          this.pendingMessages.delete(id);
          reject(new Error('Message timeout'));
        }
      }, 300000);
    });
  }

  /**
   * Write a file to FFmpeg's virtual filesystem
   */
  private async writeFile(path: string, data: Uint8Array): Promise<void> {
    logger.debug(`Writing file ${path} (${data.length} bytes)`);
    
    // Extract ArrayBuffer for transfer
    const arrayBuffer = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
    
    // Send with transferable for reliable transfer
    const id = `msg_${this.messageId++}`;
    const result = await new Promise<any>((resolve, reject) => {
      if (!this.worker) {
        reject(new Error('Worker not initialized'));
        return;
      }

      this.pendingMessages.set(id, { resolve, reject });

      // Send ArrayBuffer as transferable
      this.worker.postMessage(
        { id, type: FFMessageType.WRITE_FILE, data: { path, data: arrayBuffer } },
        [arrayBuffer]
      );

      setTimeout(() => {
        if (this.pendingMessages.has(id)) {
          this.pendingMessages.delete(id);
          reject(new Error('Write file timeout'));
        }
      }, 30000);
    });
    
    logger.debug(`File ${path} written successfully`);
    return result;
  }

  /**
   * Read a file from FFmpeg's virtual filesystem
   */
  private async readFile(path: string): Promise<Uint8Array> {
    return await this.sendMessage(FFMessageType.READ_FILE, { path });
  }

  /**
   * Delete a file from FFmpeg's virtual filesystem
   */
  private async deleteFile(path: string): Promise<void> {
    await this.sendMessage(FFMessageType.DELETE_FILE, { path });
  }

  /**
   * List directory in FFmpeg's virtual filesystem
   */
  private async listDir(path: string = '/'): Promise<any[]> {
    return await this.sendMessage(FFMessageType.LIST_DIR, { path });
  }

  /**
   * Execute FFmpeg command
   */
  private async exec(args: string[]): Promise<number> {
    // Clear logs before execution
    this.ffmpegLogs = [];
    const result = await this.sendMessage(FFMessageType.EXEC, { args, timeout: -1 });
    
    // If failed, log all FFmpeg output
    if (result !== 0) {
      logger.error(`FFmpeg failed with exit code ${result}`);
      logger.error('FFmpeg logs:', this.ffmpegLogs.join('\n'));
    }
    
    return result;
  }

  /**
   * Merge HLS segments (TS files) into MP4
   */
  async mergeHLS(segments: Blob[], outputFilename: string = 'output.mp4'): Promise<Blob> {
    if (!this.initialized) {
      await this.initialize();
    }

    try {
      logger.info(`Merging ${segments.length} HLS segments with FFmpeg...`);

      if (this.onProgress) {
        this.onProgress({ percentage: 0, message: 'Writing segments...' });
      }

      // Write segments to FFmpeg filesystem
      const segmentFiles: string[] = [];
      for (let i = 0; i < segments.length; i++) {
        const filename = `segment_${i}.ts`;
        logger.info(`Writing segment ${i + 1}/${segments.length} as ${filename}...`);
        const arrayBuffer = await segments[i].arrayBuffer();
        const uint8Array = new Uint8Array(arrayBuffer);
        logger.info(`Segment ${i + 1} size: ${uint8Array.length} bytes, type: ${uint8Array.constructor.name}`);
        try {
          await this.writeFile(filename, uint8Array);
          logger.info(`Successfully wrote segment ${i + 1}`);
        } catch (error) {
          logger.error(`Failed to write segment ${i + 1}:`, error);
          throw error;
        }
        segmentFiles.push(filename);
      }

      if (this.onProgress) {
        this.onProgress({ percentage: 20, message: 'Creating concat list...' });
      }

      // Verify segment files exist before creating concat file
      logger.info('Verifying segment files exist...');
      for (const filename of segmentFiles) {
        try {
          const testRead = await this.readFile(filename);
          logger.debug(`Verified segment file ${filename} exists (${testRead.length} bytes)`);
        } catch (error) {
          logger.error(`Segment file ${filename} does not exist!`, error);
          throw new Error(`Segment file ${filename} not found in FFmpeg filesystem`);
        }
      }

      // Create concat file list
      // Format: file 'filename' (with quotes, as per FFmpeg concat demuxer spec)
      const concatContent = segmentFiles.map((f) => `file '${f}'`).join('\n');
      logger.info('Concat file content:', concatContent);
      const concatBytes = new TextEncoder().encode(concatContent);
      await this.writeFile('concat.txt', concatBytes);
      
      // Verify concat file was written
      logger.info('Concat file written, verifying...');
      try {
        const verifyContent = await this.readFile('concat.txt');
        const verifyText = new TextDecoder().decode(verifyContent);
        logger.info('Concat file verification:', verifyText);
      } catch (error) {
        logger.warn('Could not verify concat file:', error);
      }

      if (this.onProgress) {
        this.onProgress({ percentage: 30, message: 'Running FFmpeg...' });
      }

      // List filesystem to debug
      try {
        const fsList = await this.listDir('/');
        logger.info('FFmpeg filesystem contents before exec:', fsList);
      } catch (error) {
        logger.warn('Could not list filesystem before exec:', error);
      }

      // Run FFmpeg to merge segments
      // Try multiple approaches - FFmpeg concat demuxer can be finicky
      let outputPath = outputFilename; // Try root first
      let execResult: number;
      let success = false;
      
      // Approach 1: Concat demuxer (with proper quotes format)
      // Try with explicit format specification to help FFmpeg detect TS
      try {
        // First, try specifying the demuxer format explicitly
        const ffmpegArgs = ['-f', 'concat', '-safe', '0', '-i', 'concat.txt', '-c', 'copy', '-bsf:v', 'h264_mp4toannexb', '-y', outputPath];
        logger.info('Trying FFmpeg concat demuxer (with BSF):', ffmpegArgs);
        execResult = await this.exec(ffmpegArgs);
        logger.info(`FFmpeg concat demuxer (with BSF) completed with exit code: ${execResult}`);
        if (execResult === 0) {
          success = true;
        } else {
          // Try without BSF
          const ffmpegArgs2 = ['-f', 'concat', '-safe', '0', '-i', 'concat.txt', '-c', 'copy', '-y', outputPath];
          logger.info('Trying FFmpeg concat demuxer (without BSF):', ffmpegArgs2);
          execResult = await this.exec(ffmpegArgs2);
          logger.info(`FFmpeg concat demuxer (without BSF) completed with exit code: ${execResult}`);
          if (execResult === 0) {
            success = true;
          }
        }
      } catch (error) {
        logger.warn('FFmpeg concat demuxer failed:', error);
      }
      
      // Approach 1b: Try concat protocol (for TS segments)
      if (!success) {
        try {
          const concatProtocol = `concat:${segmentFiles.join('|')}`;
          const ffmpegArgs = ['-i', concatProtocol, '-c', 'copy', '-y', outputPath];
          logger.info('Trying concat protocol:', ffmpegArgs);
          execResult = await this.exec(ffmpegArgs);
          logger.info(`FFmpeg concat protocol completed with exit code: ${execResult}`);
          if (execResult === 0) {
            success = true;
          }
        } catch (error) {
          logger.warn('FFmpeg concat protocol failed:', error);
        }
      }
      
      // Approach 2a: Try using individual inputs with explicit format and concat demuxer
      // Modify concat.txt to include format specification (if possible)
      if (!success) {
        logger.info('Trying individual FFmpeg inputs with explicit TS format...');
        try {
          // Use filter_complex with explicit TS format for each input
          // Label all inputs: [0:v][1:v][2:v]... then concat
          const inputLabels = segmentFiles.map((_, i) => `[${i}:v]`).join('');
          const filterComplex = `${inputLabels}concat=n=${segmentFiles.length}:v=1:a=0[outv]`;
          const filterArgs = [
            ...segmentFiles.flatMap(f => ['-f', 'mpegts', '-i', f]),
            '-filter_complex', filterComplex,
            '-map', '[outv]',
            '-c:v', 'copy', // Try copy first
            '-f', 'mp4',
            '-y', outputPath
          ];
          logger.info('Trying explicit TS format with copy:', filterArgs);
          execResult = await this.exec(filterArgs);
          logger.info(`Explicit TS format (copy) completed with exit code: ${execResult}`);
          if (execResult === 0) {
            success = true;
          }
        } catch (error) {
          logger.warn('Explicit TS format (copy) failed:', error);
        }
      }
      
      // Approach 2b: Use FFmpeg concat filter with re-encoding (slower but reliable)
      if (!success) {
        logger.info('Trying FFmpeg concat filter with re-encoding...');
        try {
          // Build filter complex: concat=n=3:v=1:a=0 (video only)
          const filterComplex = `concat=n=${segmentFiles.length}:v=1:a=0[outv]`;
          // Force TS format for each input
          const filterArgs = [
            ...segmentFiles.flatMap(f => ['-f', 'mpegts', '-i', f]),
            '-filter_complex', filterComplex,
            '-map', '[outv]',
            '-c:v', 'libx264',
            '-preset', 'ultrafast', // Use ultrafast for speed
            '-crf', '23',
            '-f', 'mp4',
            '-movflags', 'faststart',
            '-y', outputPath
          ];
          logger.info('Trying concat filter with re-encoding:', filterArgs);
          execResult = await this.exec(filterArgs);
          logger.info(`FFmpeg concat filter (re-encode) completed with exit code: ${execResult}`);
          if (execResult === 0) {
            success = true;
          }
        } catch (error) {
          logger.warn('Concat filter (re-encode) failed:', error);
        }
      }
      
      // Approach 3: Direct concatenation + FFmpeg conversion with explicit TS handling
      if (!success) {
        logger.info('FFmpeg concat methods failed, trying direct concatenation + conversion...');
        // Read all segments and concatenate them
        const segmentData: Uint8Array[] = [];
        for (const filename of segmentFiles) {
          const data = await this.readFile(filename);
          segmentData.push(data);
        }
        
        // Concatenate all segments into a single TS file
        const totalLength = segmentData.reduce((sum, arr) => sum + arr.length, 0);
        const concatenated = new Uint8Array(totalLength);
        let offset = 0;
        for (const data of segmentData) {
          concatenated.set(data, offset);
          offset += data.length;
        }
        
        // Write concatenated TS file
        const concatenatedTsPath = 'concatenated.ts';
        await this.writeFile(concatenatedTsPath, concatenated);
        logger.info('Direct concatenation completed, converting to MP4...');
        
        // Use FFmpeg to convert the concatenated TS to MP4
        // Specify TS packet size and use analyze flags
        try {
          // Try with explicit TS packet size and analyze duration
          const convertArgs1 = [
            '-f', 'mpegts',
            '-analyzeduration', '2147483647',
            '-probesize', '2147483647',
            '-i', concatenatedTsPath,
            '-c', 'copy',
            '-movflags', 'faststart',
            '-f', 'mp4',
            '-y', outputPath
          ];
          logger.info('Converting concatenated TS to MP4 (with analyze flags):', convertArgs1);
          execResult = await this.exec(convertArgs1);
          logger.info(`FFmpeg conversion (analyze) completed with exit code: ${execResult}`);
          
          if (execResult !== 0) {
            // Try without faststart
            logger.info('Analyze flags failed, trying simpler conversion...');
            const convertArgs2 = [
              '-f', 'mpegts',
              '-i', concatenatedTsPath,
              '-c', 'copy',
              '-f', 'mp4',
              '-y', outputPath
            ];
            execResult = await this.exec(convertArgs2);
            logger.info(`FFmpeg conversion (simple) completed with exit code: ${execResult}`);
          }
          
          if (execResult === 0) {
            success = true;
            // Verify output file exists
            try {
              const verifyOutput = await this.readFile(outputPath);
              logger.info(`Output file verified: ${verifyOutput.length} bytes`);
              // Clean up concatenated TS file
              try {
                await this.deleteFile(concatenatedTsPath);
              } catch (e) {
                logger.warn('Could not delete concatenated TS:', e);
              }
            } catch (e) {
              logger.error('Output file verification failed:', e);
              throw new Error('FFmpeg conversion succeeded but output file not found');
            }
          } else {
            // FFmpeg conversion failed - use TS file directly
            logger.warn('FFmpeg conversion failed, using concatenated TS file directly');
            outputPath = concatenatedTsPath;
            success = true;
          }
        } catch (error) {
          logger.error('FFmpeg conversion failed:', error);
          // Fallback to using concatenated TS
          logger.warn('Using concatenated TS file as fallback');
          outputPath = concatenatedTsPath;
          success = true;
        }
      }
      
      if (!success) {
        throw new Error('All FFmpeg merge approaches failed');
      }
      
      // Check tmp directory for output
      try {
        const tmpList = await this.listDir('tmp');
        logger.info('Contents of tmp/ directory:', tmpList);
      } catch (error) {
        logger.warn('Could not list tmp directory:', error);
      }

      try {
        const fsListAfter = await this.listDir('/');
        logger.info('FFmpeg filesystem contents after exec:', fsListAfter);
      } catch (error) {
        logger.warn('Could not list filesystem after exec:', error);
      }

      if (this.onProgress) {
        this.onProgress({ percentage: 80, message: 'Reading output...' });
      }

      // Read merged file
      let mergedData: Uint8Array;
      try {
        logger.info(`Reading merged output from ${outputPath}...`);
        mergedData = await this.readFile(outputPath);
      } catch (error) {
        logger.error(`Failed to read output file ${outputPath}:`, error);
        throw error;
      }
      const arrayBuffer = new Uint8Array(mergedData).buffer;
      
      // Determine blob type based on file extension
      const blobType = outputPath.endsWith('.ts') ? 'video/mp2t' : 'video/mp4';
      logger.info(`Output file type: ${blobType} (${outputPath})`);
      const mergedBlob = new Blob([arrayBuffer], { type: blobType });

      if (this.onProgress) {
        this.onProgress({ percentage: 90, message: 'Cleaning up...' });
      }

      // Cleanup
      const filesToCleanup = [...segmentFiles, 'concat.txt', 'concatenated.ts', outputPath];
      for (const file of filesToCleanup) {
        try {
          await this.deleteFile(file);
        } catch (error) {
          logger.warn(`Failed to delete ${file}:`, error);
        }
      }

      if (this.onProgress) {
        this.onProgress({ percentage: 100, message: 'Complete!' });
      }

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

      if (this.onProgress) {
        this.onProgress({ percentage: 0, message: 'Writing video segments...' });
      }

      // Write video segments
      const videoFiles: string[] = [];
      for (let i = 0; i < videoSegments.length; i++) {
        const filename = `video_${i}.m4s`;
        const arrayBuffer = await videoSegments[i].arrayBuffer();
        await this.writeFile(filename, new Uint8Array(arrayBuffer));
        videoFiles.push(filename);
      }

      // Write audio segments if available
      let audioFiles: string[] = [];
      if (audioSegments && audioSegments.length > 0) {
        if (this.onProgress) {
          this.onProgress({ percentage: 20, message: 'Writing audio segments...' });
        }

        for (let i = 0; i < audioSegments.length; i++) {
          const filename = `audio_${i}.m4s`;
          const arrayBuffer = await audioSegments[i].arrayBuffer();
          await this.writeFile(filename, new Uint8Array(arrayBuffer));
          audioFiles.push(filename);
        }
      }

      if (this.onProgress) {
        this.onProgress({ percentage: 40, message: 'Creating concat lists...' });
      }

      // Create concat files
      const videoConcatContent = videoFiles.map((f) => `file '${f}'`).join('\n');
      await this.writeFile('video_concat.txt', new TextEncoder().encode(videoConcatContent));

      if (audioFiles.length > 0) {
        const audioConcatContent = audioFiles.map((f) => `file '${f}'`).join('\n');
        await this.writeFile('audio_concat.txt', new TextEncoder().encode(audioConcatContent));
      }

      if (this.onProgress) {
        this.onProgress({ percentage: 50, message: 'Running FFmpeg...' });
      }

      // Build FFmpeg command
      const command: string[] = ['-f', 'concat', '-safe', '0', '-i', 'video_concat.txt'];

      if (audioFiles.length > 0) {
        command.push('-f', 'concat', '-safe', '0', '-i', 'audio_concat.txt');
      }

      command.push('-c:v', 'copy', '-c:a', audioFiles.length > 0 ? 'copy' : 'an', '-y', outputFilename);

      await this.exec(command);

      if (this.onProgress) {
        this.onProgress({ percentage: 80, message: 'Reading output...' });
      }

      // Read merged file
      const mergedData = await this.readFile(outputFilename);
      const arrayBuffer = new Uint8Array(mergedData).buffer;
      const mergedBlob = new Blob([arrayBuffer], { type: 'video/mp4' });

      if (this.onProgress) {
        this.onProgress({ percentage: 90, message: 'Cleaning up...' });
      }

      // Cleanup
      const cleanupFiles = [
        ...videoFiles,
        ...audioFiles,
        'video_concat.txt',
        ...(audioFiles.length > 0 ? ['audio_concat.txt'] : []),
        outputFilename,
      ];
      for (const file of cleanupFiles) {
        try {
          await this.deleteFile(file);
        } catch (error) {
          logger.warn(`Failed to delete ${file}:`, error);
        }
      }

      if (this.onProgress) {
        this.onProgress({ percentage: 100, message: 'Complete!' });
      }

      logger.info(`Successfully muxed DASH into ${mergedBlob.size} bytes`);
      return mergedBlob;
    } catch (error) {
      logger.error('DASH muxing failed:', error);
      throw new MergeError(`Failed to mux DASH segments: ${error}`);
    }
  }

  /**
   * Dispose of the worker
   */
  async dispose(): Promise<void> {
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
      this.initialized = false;
      logger.debug('FFmpeg worker terminated');
    }
  }
}

