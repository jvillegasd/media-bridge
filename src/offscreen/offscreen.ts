/**
 * Offscreen document for FFmpeg-based HLS audio/video merging
 */

import { MessageType } from '../shared/messages';
import { logger } from '../core/utils/logger';
import { FFmpeg } from '@ffmpeg/ffmpeg';
import { fetchFile, toBlobURL } from '@ffmpeg/util';

// Singleton FFmpeg instance (like the competitor)
class FFmpegSingleton {
  private static instance: FFmpeg | null = null;
  private static isLoaded = false;

  static async getInstance(): Promise<FFmpeg> {
    if (!FFmpegSingleton.instance) {
      FFmpegSingleton.instance = new FFmpeg();

      const baseURL = chrome.runtime.getURL('ffmpeg');
      logger.info(`Loading FFmpeg from: ${baseURL}`);
      
      await FFmpegSingleton.instance.load({
        coreURL: chrome.runtime.getURL('ffmpeg/ffmpeg-core.js'),
        wasmURL: chrome.runtime.getURL('ffmpeg/ffmpeg-core.wasm'),
      });

      // Set up logging
      FFmpegSingleton.instance.on('log', ({ message }) => {
        logger.debug('FFmpeg:', message);
      });

      FFmpegSingleton.isLoaded = true;
      logger.info('FFmpeg loaded successfully');
    }

    return FFmpegSingleton.instance;
  }

  static isFFmpegLoaded(): boolean {
    return FFmpegSingleton.isLoaded;
  }
}

/**
 * Merge video and audio segments using FFmpeg
 */
async function mergeWithFFmpeg(
  videoSegments: ArrayBuffer[],
  audioSegments: ArrayBuffer[],
  onProgress?: (progress: number, message: string) => void
): Promise<Blob> {
  const ffmpeg = await FFmpegSingleton.getInstance();

  try {
    // Determine output filename
    const outputFileName = '/tmp/output.mp4';

    // Process based on available streams (like the competitor)
    if (videoSegments.length > 0 && audioSegments.length > 0) {
      await processVideoAndAudio(ffmpeg, videoSegments, audioSegments, outputFileName, onProgress);
    } else if (videoSegments.length > 0) {
      await processVideoOnly(ffmpeg, videoSegments, outputFileName, onProgress);
    } else if (audioSegments.length > 0) {
      await processAudioOnly(ffmpeg, audioSegments, outputFileName, onProgress);
    } else {
      throw new Error('No video or audio segments provided');
    }

    // Read the merged file
    onProgress?.(0.9, 'Reading merged output...');
    const data = await ffmpeg.readFile(outputFileName);
    onProgress?.(1, 'Merge complete');
    
    // Convert FileData to BlobPart
    // readFile returns Uint8Array for binary files
    const dataArray = data as Uint8Array;
    // Create a new Uint8Array copy to ensure we have a proper ArrayBuffer
    const dataCopy = new Uint8Array(dataArray);
    return new Blob([dataCopy], { type: 'video/mp4' });
  } catch (error) {
    logger.error('FFmpeg merge failed:', error);
    throw error;
  }
}

/**
 * Process video and audio together
 */
async function processVideoAndAudio(
  ffmpeg: FFmpeg,
  videoSegments: ArrayBuffer[],
  audioSegments: ArrayBuffer[],
  outputFileName: string,
  onProgress?: (progress: number, message: string) => void
): Promise<void> {
  onProgress?.(0.1, 'Concatenating video chunks');
  const videoBlob = concatenateSegments(videoSegments);

  onProgress?.(0.3, 'Concatenating audio chunks');
  const audioBlob = concatenateSegments(audioSegments);

  onProgress?.(0.5, 'Writing video stream');
  await ffmpeg.writeFile('video.ts', await fetchFile(videoBlob));

  onProgress?.(0.6, 'Writing audio stream');
  await ffmpeg.writeFile('audio.ts', await fetchFile(audioBlob));

  onProgress?.(0.7, 'Merging video and audio');
  await ffmpeg.exec([
    '-y',
    '-i', 'video.ts',
    '-i', 'audio.ts',
    '-c:v', 'copy',
    '-c:a', 'copy',
    '-bsf:a', 'aac_adtstoasc',
    '-shortest',
    '-movflags', '+faststart',
    outputFileName,
  ]);

  // Cleanup intermediate files
  try {
    await ffmpeg.deleteFile('video.ts');
    await ffmpeg.deleteFile('audio.ts');
  } catch (error) {
    // Files may not exist, ignore error
  }
}

/**
 * Process video only
 */
async function processVideoOnly(
  ffmpeg: FFmpeg,
  videoSegments: ArrayBuffer[],
  outputFileName: string,
  onProgress?: (progress: number, message: string) => void
): Promise<void> {
  onProgress?.(0.2, 'Concatenating video chunks');
  const videoBlob = concatenateSegments(videoSegments);

  onProgress?.(0.5, 'Writing video stream');
  await ffmpeg.writeFile('video.ts', await fetchFile(videoBlob));

  onProgress?.(0.7, 'Transcoding video');
  await ffmpeg.exec([
    '-y',
    '-i', 'video.ts',
    '-c:v', 'copy',
    '-movflags', '+faststart',
    outputFileName,
  ]);

  // Cleanup
  try {
    await ffmpeg.deleteFile('video.ts');
  } catch (error) {
    // File may not exist, ignore error
  }
}

/**
 * Process audio only
 */
async function processAudioOnly(
  ffmpeg: FFmpeg,
  audioSegments: ArrayBuffer[],
  outputFileName: string,
  onProgress?: (progress: number, message: string) => void
): Promise<void> {
  onProgress?.(0.2, 'Concatenating audio chunks');
  const audioBlob = concatenateSegments(audioSegments);

  onProgress?.(0.5, 'Writing audio stream');
  await ffmpeg.writeFile('audio.ts', await fetchFile(audioBlob));

  onProgress?.(0.7, 'Transcoding audio');
  await ffmpeg.exec([
    '-y',
    '-i', 'audio.ts',
    '-c:a', 'aac',
    '-b:a', '192k',
    '-af', 'aresample=async=1:first_pts=0',
    '-movflags', '+faststart',
    outputFileName,
  ]);

  // Cleanup
  try {
    await ffmpeg.deleteFile('audio.ts');
  } catch (error) {
    // File may not exist, ignore error
  }
}

/**
 * Concatenate segments into a single blob
 */
function concatenateSegments(segments: ArrayBuffer[]): Blob {
  const chunks: BlobPart[] = segments.map(seg => new Uint8Array(seg));
  return new Blob(chunks);
}

/**
 * Handle merge requests from service worker
 */
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type !== MessageType.OFFSCREEN_MERGE_REQUEST) {
    return false;
  }

  const { videoSegments, audioSegments } = message.payload || {};

  if (!videoSegments || !Array.isArray(videoSegments)) {
    sendResponse({
      success: false,
      error: 'Invalid video segments provided',
    });
    return false;
  }

  // Create progress callback that sends messages back
  const progressCallback = (progress: number, progressMessage: string) => {
    try {
      chrome.runtime.sendMessage({
        type: MessageType.OFFSCREEN_MERGE_REQUEST,
        progress,
        message: progressMessage,
      }).catch(() => {
        // Ignore errors if service worker is not listening
      });
    } catch (error) {
      // Ignore errors
    }
  };

  // Merge with FFmpeg
  mergeWithFFmpeg(
    videoSegments,
    audioSegments || [],
    progressCallback
  )
    .then((blob) => {
      // Convert blob to ArrayBuffer for transfer
      return blob.arrayBuffer();
    })
    .then((arrayBuffer) => {
      sendResponse({
        success: true,
        data: arrayBuffer,
      });
    })
    .catch((error) => {
      logger.error('Merge request failed:', error);
      sendResponse({
        success: false,
        error: error instanceof Error ? error.message : String(error),
      });
    });

  return true; // Keep channel open for async response
});
