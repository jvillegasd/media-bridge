/**
 * Offscreen document script for FFmpeg processing
 * Handles HLS video processing using FFmpeg.wasm
 */

import { FFmpeg } from "@ffmpeg/ffmpeg";
import { fetchFile } from "@ffmpeg/util";
import { MessageType } from "../shared/messages";
import { readChunkByIndex } from "../core/database/chunks";
import { logger } from "../core/utils/logger";

let ffmpegInstance: FFmpeg | null = null;

/**
 * Initialize FFmpeg instance
 */
async function getFFmpeg(): Promise<FFmpeg> {
  if (!ffmpegInstance) {
    logger.info("Initializing FFmpeg in offscreen document");
    ffmpegInstance = new FFmpeg();

    await ffmpegInstance.load({
      coreURL: chrome.runtime.getURL("./ffmpeg/core/ffmpeg-core.js"),
      wasmURL: chrome.runtime.getURL("./ffmpeg/core/ffmpeg-core.wasm"),
    });

    ffmpegInstance.on("log", ({ message }) => {
      logger.debug("FFmpeg:", message);
    });

    logger.info("FFmpeg initialized successfully");
  }

  return ffmpegInstance;
}

/**
 * Concatenate chunks from IndexedDB
 */
async function concatenateChunks(
  downloadId: string,
  startIndex: number,
  length: number,
): Promise<Blob> {
  const chunks: Uint8Array[] = [];

  for (let i = 0; i < length; i++) {
    const chunk = await readChunkByIndex(downloadId, startIndex + i);
    if (chunk) {
      chunks.push(chunk);
    }
  }

  return new Blob(chunks, { type: "video/mp2t" });
}

/**
 * Process video and audio streams with FFmpeg
 */
async function processVideoAndAudio(
  ffmpeg: FFmpeg,
  downloadId: string,
  videoLength: number,
  audioLength: number,
  outputFileName: string,
  onProgress?: (progress: number, message: string) => void,
): Promise<void> {
  onProgress?.(0.1, "Concatenating video chunks");
  const videoBlob = await concatenateChunks(downloadId, 0, videoLength);

  onProgress?.(0.3, "Concatenating audio chunks");
  const audioBlob = await concatenateChunks(
    downloadId,
    videoLength,
    audioLength,
  );

  onProgress?.(0.5, "Writing video stream");
  await ffmpeg.writeFile("video.ts", await fetchFile(videoBlob));

  onProgress?.(0.6, "Writing audio stream");
  await ffmpeg.writeFile("audio.ts", await fetchFile(audioBlob));

  onProgress?.(0.7, "Merging video and audio");
  await ffmpeg.exec([
    "-y",
    "-i",
    "video.ts",
    "-i",
    "audio.ts",
    "-c:v",
    "copy",
    "-c:a",
    "copy",
    "-bsf:a",
    "aac_adtstoasc",
    "-shortest",
    "-movflags",
    "+faststart",
    outputFileName,
  ]);

  // Cleanup intermediate files
  try {
    await ffmpeg.deleteFile("video.ts");
    await ffmpeg.deleteFile("audio.ts");
  } catch (error) {
    // Files may not exist, ignore error
  }
}

/**
 * Process video only stream with FFmpeg
 */
async function processVideoOnly(
  ffmpeg: FFmpeg,
  downloadId: string,
  videoLength: number,
  outputFileName: string,
  onProgress?: (progress: number, message: string) => void,
): Promise<void> {
  onProgress?.(0.2, "Concatenating video chunks");
  const videoBlob = await concatenateChunks(downloadId, 0, videoLength);

  onProgress?.(0.5, "Writing video stream");
  await ffmpeg.writeFile("video.ts", await fetchFile(videoBlob));

  onProgress?.(0.7, "Converting to MP4");
  await ffmpeg.exec([
    "-y",
    "-i",
    "video.ts",
    "-c:v",
    "copy",
    "-movflags",
    "+faststart",
    outputFileName,
  ]);

  // Cleanup intermediate files
  try {
    await ffmpeg.deleteFile("video.ts");
  } catch (error) {
    // File may not exist, ignore error
  }
}

/**
 * Process M3U8 media playlist with FFmpeg
 * Media playlists contain MPEG-TS segments with combined video+audio streams
 */
async function processM3u8MediaPlaylist(
  ffmpeg: FFmpeg,
  downloadId: string,
  fragmentCount: number,
  outputFileName: string,
  onProgress?: (progress: number, message: string) => void,
): Promise<void> {
  onProgress?.(0.2, "Concatenating media playlist chunks");
  const mediaBlob = await concatenateChunks(downloadId, 0, fragmentCount);

  onProgress?.(0.5, "Writing media stream");
  await ffmpeg.writeFile("media.ts", await fetchFile(mediaBlob));

  onProgress?.(0.7, "Converting to MP4");
  // Use -c copy to copy all streams (video and audio) since media playlists
  // contain combined MPEG-TS streams with both video and audio
  await ffmpeg.exec([
    "-y",
    "-i",
    "media.ts",
    "-c",
    "copy", // Copy all codecs (video and audio)
    "-bsf:a",
    "aac_adtstoasc", // Convert AAC ADTS to ASC for better compatibility
    "-movflags",
    "+faststart",
    outputFileName,
  ]);

  // Cleanup intermediate files
  try {
    await ffmpeg.deleteFile("media.ts");
  } catch (error) {
    // File may not exist, ignore error
  }
}

/**
 * Process audio only stream with FFmpeg
 */
async function processAudioOnly(
  ffmpeg: FFmpeg,
  downloadId: string,
  audioLength: number,
  outputFileName: string,
  onProgress?: (progress: number, message: string) => void,
): Promise<void> {
  onProgress?.(0.2, "Concatenating audio chunks");
  const audioBlob = await concatenateChunks(downloadId, 0, audioLength);

  onProgress?.(0.5, "Writing audio stream");
  await ffmpeg.writeFile("audio.ts", await fetchFile(audioBlob));

  onProgress?.(0.7, "Converting to MP4");
  await ffmpeg.exec([
    "-y",
    "-i",
    "audio.ts",
    "-c:a",
    "copy",
    "-movflags",
    "+faststart",
    outputFileName,
  ]);

  // Cleanup intermediate files
  try {
    await ffmpeg.deleteFile("audio.ts");
  } catch (error) {
    // File may not exist, ignore error
  }
}

/**
 * Process HLS chunks and convert to MP4
 */
async function processHLSChunks(
  downloadId: string,
  videoLength: number,
  audioLength: number,
  filename: string,
  onProgress?: (progress: number, message: string) => void,
): Promise<string> {
  const ffmpeg = await getFFmpeg();

  // Extract base filename without extension
  const baseFileName = filename.replace(/\.[^/.]+$/, "");
  const outputFileName = `/tmp/${baseFileName}.mp4`;

  // Process based on available streams
  if (videoLength > 0 && audioLength > 0) {
    await processVideoAndAudio(
      ffmpeg,
      downloadId,
      videoLength,
      audioLength,
      outputFileName,
      onProgress,
    );
  } else if (videoLength > 0) {
    await processVideoOnly(
      ffmpeg,
      downloadId,
      videoLength,
      outputFileName,
      onProgress,
    );
  } else if (audioLength > 0) {
    await processAudioOnly(
      ffmpeg,
      downloadId,
      audioLength,
      outputFileName,
      onProgress,
    );
  } else {
    throw new Error("No video or audio chunks to process");
  }

  // Read the output file
  try {
    const data = await ffmpeg.readFile(outputFileName);
    onProgress?.(1, "Done");

    // Create blob URL
    const blob = new Blob([data], { type: "video/mp4" });
    const blobUrl = URL.createObjectURL(blob);

    // Cleanup output file
    try {
      await ffmpeg.deleteFile(outputFileName);
    } catch (error) {
      // File may not exist, ignore error
    }

    return blobUrl;
  } catch (error) {
    logger.error(`Failed to read output file ${outputFileName}:`, error);
    throw new Error(`Output file ${outputFileName} was not created by FFmpeg`);
  }
}

/**
 * Process M3U8 media playlist chunks and convert to MP4
 */
async function processM3u8Chunks(
  downloadId: string,
  fragmentCount: number,
  filename: string,
  onProgress?: (progress: number, message: string) => void,
): Promise<string> {
  const ffmpeg = await getFFmpeg();

  // Extract base filename without extension
  const baseFileName = filename.replace(/\.[^/.]+$/, "");
  const outputFileName = `/tmp/${baseFileName}.mp4`;

  if (fragmentCount === 0) {
    throw new Error("No fragments to process");
  }

  // Process M3U8 media playlist
  await processM3u8MediaPlaylist(
    ffmpeg,
    downloadId,
    fragmentCount,
    outputFileName,
    onProgress,
  );

  // Read the output file
  try {
    const data = await ffmpeg.readFile(outputFileName);
    onProgress?.(1, "Done");

    // Create blob URL
    const blob = new Blob([data], { type: "video/mp4" });
    const blobUrl = URL.createObjectURL(blob);

    // Cleanup output file
    try {
      await ffmpeg.deleteFile(outputFileName);
    } catch (error) {
      // File may not exist, ignore error
    }

    return blobUrl;
  } catch (error) {
    logger.error(`Failed to read output file ${outputFileName}:`, error);
    throw new Error(`Output file ${outputFileName} was not created by FFmpeg`);
  }
}

/**
 * Handle messages from service worker
 */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Handle OFFSCREEN_PROCESS_HLS messages
  if (message.type === MessageType.OFFSCREEN_PROCESS_HLS) {
    const { downloadId, videoLength, audioLength, filename } = message.payload;

    // Acknowledge receipt immediately
    sendResponse({ acknowledged: true });

    // Process asynchronously and send responses via separate messages
    processHLSChunks(
      downloadId,
      videoLength,
      audioLength,
      filename,
      (progress, message) => {
        // Send progress updates back to service worker
        chrome.runtime.sendMessage(
          {
            type: MessageType.OFFSCREEN_PROCESS_HLS_RESPONSE,
            payload: {
              downloadId,
              type: "progress",
              progress,
              message,
            },
          },
          () => {
            // Check for errors to prevent "unchecked runtime.lastError" warning
            if (chrome.runtime.lastError) {
              // Ignore - service worker might not be listening
            }
          },
        );
      },
    )
      .then((blobUrl) => {
        // Send success response
        chrome.runtime.sendMessage(
          {
            type: MessageType.OFFSCREEN_PROCESS_HLS_RESPONSE,
            payload: {
              downloadId,
              type: "success",
              blobUrl,
            },
          },
          () => {
            // Check for errors to prevent "unchecked runtime.lastError" warning
            if (chrome.runtime.lastError) {
              // Ignore - service worker might not be listening
            }
          },
        );
      })
      .catch((error) => {
        // Send error response
        chrome.runtime.sendMessage(
          {
            type: MessageType.OFFSCREEN_PROCESS_HLS_RESPONSE,
            payload: {
              downloadId,
              type: "error",
              error: error instanceof Error ? error.message : String(error),
            },
          },
          () => {
            // Check for errors to prevent "unchecked runtime.lastError" warning
            if (chrome.runtime.lastError) {
              // Ignore - service worker might not be listening
            }
          },
        );
      });

    // Return true to indicate async response (we called sendResponse above)
    return true;
  }

  // Handle OFFSCREEN_PROCESS_M3U8 messages
  if (message.type === MessageType.OFFSCREEN_PROCESS_M3U8) {
    const { downloadId, fragmentCount, filename } = message.payload;

    // Acknowledge receipt immediately
    sendResponse({ acknowledged: true });

    // Process asynchronously and send responses via separate messages
    processM3u8Chunks(
      downloadId,
      fragmentCount,
      filename,
      (progress, message) => {
        // Send progress updates back to service worker
        chrome.runtime.sendMessage(
          {
            type: MessageType.OFFSCREEN_PROCESS_M3U8_RESPONSE,
            payload: {
              downloadId,
              type: "progress",
              progress,
              message,
            },
          },
          () => {
            // Check for errors to prevent "unchecked runtime.lastError" warning
            if (chrome.runtime.lastError) {
              // Ignore - service worker might not be listening
            }
          },
        );
      },
    )
      .then((blobUrl) => {
        // Send success response
        chrome.runtime.sendMessage(
          {
            type: MessageType.OFFSCREEN_PROCESS_M3U8_RESPONSE,
            payload: {
              downloadId,
              type: "success",
              blobUrl,
            },
          },
          () => {
            // Check for errors to prevent "unchecked runtime.lastError" warning
            if (chrome.runtime.lastError) {
              // Ignore - service worker might not be listening
            }
          },
        );
      })
      .catch((error) => {
        // Send error response
        chrome.runtime.sendMessage(
          {
            type: MessageType.OFFSCREEN_PROCESS_M3U8_RESPONSE,
            payload: {
              downloadId,
              type: "error",
              error: error instanceof Error ? error.message : String(error),
            },
          },
          () => {
            // Check for errors to prevent "unchecked runtime.lastError" warning
            if (chrome.runtime.lastError) {
              // Ignore - service worker might not be listening
            }
          },
        );
      });

    // Return true to indicate async response (we called sendResponse above)
    return true;
  }

  // Return false for messages we don't handle (don't log warnings)
  return false;
});

logger.info("Offscreen document script loaded");
