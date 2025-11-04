/**
 * Offscreen document for FFmpeg-based HLS audio/video merging
 */

import { MessageType } from '../shared/messages';
import { logger } from '../core/utils/logger';

// FFmpeg will be loaded dynamically
let ffmpeg: any = null;
let ffmpegLoaded = false;

/**
 * Load FFmpeg core directly (no wrapper classes needed)
 * Uses ffmpeg-core.js and ffmpeg-core.wasm only - simpler and more efficient!
 */
async function loadFFmpeg(): Promise<void> {
  if (ffmpegLoaded) {
    return;
  }

  try {
    const coreUrl = chrome.runtime.getURL('ffmpeg/ffmpeg-core.js');
    const wasmUrl = chrome.runtime.getURL('ffmpeg/ffmpeg-core.wasm');
    
    logger.info(`Loading FFmpeg core from: ${coreUrl}`);
    
    // Import ffmpeg-core.js directly - it exports createFFmpegCore as default
    const module = await import(coreUrl);
    const createFFmpegCore = module.default;
    
    if (!createFFmpegCore) {
      throw new Error('createFFmpegCore not found in ffmpeg-core.js');
    }
    
    logger.info('FFmpeg core module loaded, initializing with WASM...');
    
    // Initialize FFmpeg core with WASM file
    // The mainScriptUrlOrBlob hack encodes the WASM URL to help locateFile find it
    ffmpeg = await createFFmpegCore({
      mainScriptUrlOrBlob: `${coreUrl}#${btoa(JSON.stringify({ wasmURL: wasmUrl }))}`,
    });
    
    // Set up logging and progress callbacks
    ffmpeg.setLogger((data: any) => {
      logger.debug('FFmpeg:', data);
    });
    
    ffmpeg.setProgress((data: any) => {
      // Progress callback can be used for detailed progress tracking
      logger.debug('FFmpeg progress:', data);
    });
    
    // Wait for FFmpeg to be ready
    await ffmpeg.ready;
    
    ffmpegLoaded = true;
    logger.info('FFmpeg core loaded successfully');
  } catch (error) {
    logger.error('Failed to load FFmpeg core:', error);
    throw error;
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
  if (!ffmpegLoaded) {
    await loadFFmpeg();
  }

  try {
    onProgress?.(0.1, 'Writing video segments to FFmpeg...');
    
    // Concatenate video segments into a single file
    const videoCombined = new Uint8Array(
      videoSegments.reduce((sum, buf) => sum + buf.byteLength, 0)
    );
    let offset = 0;
    for (const buffer of videoSegments) {
      videoCombined.set(new Uint8Array(buffer), offset);
      offset += buffer.byteLength;
    }
    
    // Write video file using FFmpeg's FS API
    ffmpeg.FS.writeFile('video.mp4', videoCombined);
    
    onProgress?.(0.3, 'Writing audio segments to FFmpeg...');
    
    // Concatenate audio segments into a single file
    const audioCombined = new Uint8Array(
      audioSegments.reduce((sum, buf) => sum + buf.byteLength, 0)
    );
    offset = 0;
    for (const buffer of audioSegments) {
      audioCombined.set(new Uint8Array(buffer), offset);
      offset += buffer.byteLength;
    }
    
    // Write audio file
    ffmpeg.FS.writeFile('audio.mp4', audioCombined);
    
    onProgress?.(0.5, 'Merging audio and video with FFmpeg...');
    
    // Use FFmpeg core's exec() method directly
    // -i video.mp4 -i audio.mp4 -c:v copy -c:a aac -shortest output.mp4
    const exitCode = ffmpeg.exec([
      '-i', 'video.mp4',
      '-i', 'audio.mp4',
      '-c:v', 'copy',  // Copy video codec (no re-encoding)
      '-c:a', 'aac',   // Encode audio as AAC
      '-shortest',     // Use shortest stream duration
      'output.mp4'
    ]);
    
    if (exitCode !== 0) {
      throw new Error(`FFmpeg exec failed with exit code ${exitCode}`);
    }
    
    onProgress?.(0.9, 'Reading merged output...');
    
    // Read the merged file using FS API
    const mergedData = ffmpeg.FS.readFile('output.mp4');
    
    // Cleanup
    try {
      ffmpeg.FS.unlink('video.mp4');
      ffmpeg.FS.unlink('audio.mp4');
      ffmpeg.FS.unlink('output.mp4');
    } catch (e) {
      // Ignore cleanup errors
    }
    
    onProgress?.(1, 'Merge complete');
    
    return new Blob([mergedData], { type: 'video/mp4' });
  } catch (error) {
    logger.error('FFmpeg merge failed:', error);
    throw error;
  }
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


