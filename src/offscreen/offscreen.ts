/**
 * Offscreen document script for FFmpeg processing
 * Handles HLS video processing using FFmpeg.wasm
 */

import { FFmpeg } from "@ffmpeg/ffmpeg";
import { fetchFile } from "@ffmpeg/util";
import { MessageType } from "../shared/messages";
import { readChunkRange } from "../core/database/chunks";
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
 * Reset FFmpeg instance so the next call to getFFmpeg() creates a fresh one.
 * Must be called after any FFmpeg failure (e.g. Aborted()) to avoid reusing
 * a corrupted WASM instance.
 */
function resetFFmpeg(): void {
  if (ffmpegInstance) {
    try {
      ffmpegInstance.terminate();
    } catch {
      // Instance may already be in a broken state
    }
    ffmpegInstance = null;
    logger.info("FFmpeg instance reset after failure");
  }
}

/**
 * Promise-based processing queue to serialize FFmpeg jobs.
 * FFmpeg.wasm is single-threaded — concurrent exec() calls corrupt shared WASM state.
 */
let processingQueue: Promise<void> = Promise.resolve();

function enqueue<T>(job: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    processingQueue = processingQueue.then(async () => {
      try {
        resolve(await job());
      } catch (error) {
        reject(error);
      }
    });
  });
}

const VALID_DOWNLOAD_ID = /^[a-zA-Z0-9_-]+$/;

function validateDownloadId(downloadId: string): void {
  if (!downloadId || !VALID_DOWNLOAD_ID.test(downloadId)) {
    throw new Error(`Invalid downloadId: ${downloadId}`);
  }
}

/**
 * Concatenate chunks from IndexedDB
 */
interface ConcatenateResult {
  blob: Blob;
  missingCount: number;
  totalCount: number;
}

async function concatenateChunks(
  downloadId: string,
  startIndex: number,
  length: number,
): Promise<ConcatenateResult> {
  const chunkMap = await readChunkRange(downloadId, startIndex, length);

  const chunks: BlobPart[] = [];
  let missingCount = 0;
  let totalBytes = 0;

  for (let i = 0; i < length; i++) {
    const chunk = chunkMap.get(startIndex + i);
    if (chunk) {
      chunks.push(chunk as BlobPart);
      totalBytes += chunk.byteLength;
    } else {
      missingCount++;
      logger.warn(`Missing chunk at index ${startIndex + i} for ${downloadId}`);
    }
  }

  logger.info(
    `Concatenated ${chunks.length}/${length} chunks (${totalBytes} bytes, ${missingCount} missing) for ${downloadId}`,
  );

  return {
    blob: new Blob(chunks, { type: "video/mp2t" }),
    missingCount,
    totalCount: length,
  };
}

/**
 * Process video and audio streams with FFmpeg
 */
/**
 * Safely clean up intermediate files from FFmpeg's virtual filesystem
 */
async function cleanupFiles(
  ffmpeg: FFmpeg,
  filenames: string[],
): Promise<void> {
  for (const name of filenames) {
    try {
      await ffmpeg.deleteFile(name);
    } catch {
      logger.debug(
        `Could not delete intermediate file ${name} (may not exist)`,
      );
    }
  }
}

/**
 * Build a user-facing warning string from missing chunk counts.
 * Returns undefined if no chunks are missing.
 */
function buildMissingChunksWarning(
  missingCount: number,
  totalCount: number,
): string | undefined {
  if (missingCount === 0 || totalCount === 0) return undefined;
  const pct = ((missingCount / totalCount) * 100).toFixed(1);
  return `${missingCount} of ${totalCount} chunks were missing (${pct}%) — video may have gaps`;
}

async function processVideoAndAudio(
  ffmpeg: FFmpeg,
  downloadId: string,
  videoLength: number,
  audioLength: number,
  outputFileName: string,
  onProgress?: (progress: number, message: string) => void,
): Promise<string | undefined> {
  const videoFile = `${downloadId}_video.ts`;
  const audioFile = `${downloadId}_audio.ts`;
  const intermediateFiles = [videoFile, audioFile];

  try {
    onProgress?.(0.1, "Concatenating chunks");
    const [videoResult, audioResult] = await Promise.all([
      concatenateChunks(downloadId, 0, videoLength),
      concatenateChunks(downloadId, videoLength, audioLength),
    ]);

    onProgress?.(0.5, "Writing video stream");
    await ffmpeg.writeFile(videoFile, await fetchFile(videoResult.blob));

    onProgress?.(0.6, "Writing audio stream");
    await ffmpeg.writeFile(audioFile, await fetchFile(audioResult.blob));

    onProgress?.(0.7, "Merging video and audio");
    await ffmpeg.exec([
      "-y",
      "-i",
      videoFile,
      "-i",
      audioFile,
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

    const totalMissing = videoResult.missingCount + audioResult.missingCount;
    const totalChunks = videoResult.totalCount + audioResult.totalCount;
    return buildMissingChunksWarning(totalMissing, totalChunks);
  } finally {
    await cleanupFiles(ffmpeg, intermediateFiles);
  }
}

/**
 * Process a single stream (video-only, media playlist, or audio-only muxed content).
 * Handles concatenation, writing, and converting to MP4.
 *
 * Note: HLS streams from master playlists often have audio muxed into the video
 * segments (indicated by codecs like "avc1.64001e,mp4a.40.2"). When there's no
 * separate audio playlist, we copy ALL streams to preserve the embedded audio.
 */
async function processSingleStream(
  ffmpeg: FFmpeg,
  downloadId: string,
  length: number,
  startIndex: number,
  streamLabel: string,
  outputFileName: string,
  ffmpegArgs: string[],
  onProgress?: (progress: number, message: string) => void,
): Promise<string | undefined> {
  const inputFile = `${downloadId}_${streamLabel}.ts`;

  try {
    onProgress?.(0.2, `Concatenating ${streamLabel} chunks`);
    const result = await concatenateChunks(downloadId, startIndex, length);

    onProgress?.(0.5, `Writing ${streamLabel} stream`);
    await ffmpeg.writeFile(inputFile, await fetchFile(result.blob));

    onProgress?.(0.7, "Converting to MP4");
    await ffmpeg.exec(["-y", "-i", inputFile, ...ffmpegArgs, outputFileName]);

    return buildMissingChunksWarning(result.missingCount, result.totalCount);
  } finally {
    await cleanupFiles(ffmpeg, [inputFile]);
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
): Promise<string | undefined> {
  return processSingleStream(
    ffmpeg,
    downloadId,
    audioLength,
    0,
    "audio",
    outputFileName,
    ["-c:a", "copy", "-movflags", "+faststart"],
    onProgress,
  );
}

/**
 * Process HLS chunks and convert to MP4
 */
interface ProcessResult {
  blobUrl: string;
  warning?: string;
}

async function processHLSChunks(
  downloadId: string,
  videoLength: number,
  audioLength: number,
  onProgress?: (progress: number, message: string) => void,
): Promise<ProcessResult> {
  validateDownloadId(downloadId);
  const ffmpeg = await getFFmpeg();

  const outputFileName = `/tmp/${downloadId}.mp4`;

  // Process based on available streams
  try {
    let warning: string | undefined;

    if (videoLength > 0 && audioLength > 0) {
      warning = await processVideoAndAudio(
        ffmpeg,
        downloadId,
        videoLength,
        audioLength,
        outputFileName,
        onProgress,
      );
    } else if (videoLength > 0) {
      warning = await processSingleStream(
        ffmpeg,
        downloadId,
        videoLength,
        0,
        "video",
        outputFileName,
        ["-c", "copy", "-bsf:a", "aac_adtstoasc", "-movflags", "+faststart"],
        onProgress,
      );
    } else if (audioLength > 0) {
      warning = await processAudioOnly(
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
    const data = await ffmpeg.readFile(outputFileName);
    onProgress?.(1, "Done");

    // Create blob URL
    const blob = new Blob([data as BlobPart], { type: "video/mp4" });
    const blobUrl = URL.createObjectURL(blob);

    // Cleanup output file
    try {
      await ffmpeg.deleteFile(outputFileName);
    } catch {
      // File may not exist, ignore error
    }

    return { blobUrl, warning };
  } catch (error) {
    resetFFmpeg();
    logger.error(`FFmpeg processing failed for ${downloadId}:`, error);
    throw error;
  }
}

/**
 * Process M3U8 media playlist chunks and convert to MP4
 */
async function processM3u8Chunks(
  downloadId: string,
  fragmentCount: number,
  onProgress?: (progress: number, message: string) => void,
): Promise<ProcessResult> {
  validateDownloadId(downloadId);
  const ffmpeg = await getFFmpeg();

  const outputFileName = `/tmp/${downloadId}.mp4`;

  if (fragmentCount === 0) {
    throw new Error("No fragments to process");
  }

  try {
    // Process M3U8 media playlist
    const warning = await processSingleStream(
      ffmpeg,
      downloadId,
      fragmentCount,
      0,
      "media",
      outputFileName,
      ["-c", "copy", "-bsf:a", "aac_adtstoasc", "-movflags", "+faststart"],
      onProgress,
    );

    // Read the output file
    const data = await ffmpeg.readFile(outputFileName);
    onProgress?.(1, "Done");

    // Create blob URL
    const blob = new Blob([data as BlobPart], { type: "video/mp4" });
    const blobUrl = URL.createObjectURL(blob);

    // Cleanup output file
    try {
      await ffmpeg.deleteFile(outputFileName);
    } catch {
      // File may not exist, ignore error
    }

    return { blobUrl, warning };
  } catch (error) {
    resetFFmpeg();
    logger.error(`FFmpeg processing failed for ${downloadId}:`, error);
    throw error;
  }
}

/**
 * Send a message to the service worker, swallowing any errors
 * (the service worker might not be listening).
 */
function sendToServiceWorker(msg: object): void {
  chrome.runtime.sendMessage(msg, () => {
    if (chrome.runtime.lastError) {
      /* intentionally swallowed */
    }
  });
}

/**
 * Wire up an async FFmpeg processing handler for a given message type.
 * Returns true if the message was handled, false otherwise.
 */
function handleProcessingMessage(
  message: { type: string; payload: Record<string, unknown> },
  sendResponse: (response: unknown) => void,
  requestType: MessageType,
  responseType: MessageType,
  processFn: (
    payload: Record<string, unknown>,
    onProgress: (progress: number, message: string) => void,
  ) => Promise<ProcessResult>,
): boolean {
  if (message.type !== requestType) return false;

  const { downloadId } = message.payload;
  sendResponse({ acknowledged: true });

  enqueue(() =>
    processFn(message.payload, (progress, msg) => {
      sendToServiceWorker({
        type: responseType,
        payload: { downloadId, type: "progress", progress, message: msg },
      });
    }),
  )
    .then(({ blobUrl, warning }) => {
      sendToServiceWorker({
        type: responseType,
        payload: { downloadId, type: "success", blobUrl, warning },
      });
    })
    .catch((error) => {
      sendToServiceWorker({
        type: responseType,
        payload: {
          downloadId,
          type: "error",
          error: error instanceof Error ? error.message : String(error),
        },
      });
    });

  return true;
}

/**
 * Handle messages from service worker
 */
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (
    handleProcessingMessage(
      message,
      sendResponse,
      MessageType.OFFSCREEN_PROCESS_HLS,
      MessageType.OFFSCREEN_PROCESS_HLS_RESPONSE,
      (payload, onProgress) =>
        processHLSChunks(
          payload.downloadId as string,
          payload.videoLength as number,
          payload.audioLength as number,
          onProgress,
        ),
    )
  )
    return true;

  if (
    handleProcessingMessage(
      message,
      sendResponse,
      MessageType.OFFSCREEN_PROCESS_M3U8,
      MessageType.OFFSCREEN_PROCESS_M3U8_RESPONSE,
      (payload, onProgress) =>
        processM3u8Chunks(
          payload.downloadId as string,
          payload.fragmentCount as number,
          onProgress,
        ),
    )
  )
    return true;

  // Pre-warm FFmpeg while segments are downloading
  if (message.type === MessageType.WARMUP_FFMPEG) {
    sendResponse({ acknowledged: true });
    getFFmpeg().catch((err) => logger.error("FFmpeg warmup failed:", err));
    return false;
  }

  // Revoke a blob URL that was created in this offscreen document context
  if (message.type === MessageType.REVOKE_BLOB_URL) {
    const { blobUrl } = message.payload;
    URL.revokeObjectURL(blobUrl);
    sendResponse({ acknowledged: true });
    return false;
  }

  // Return false for messages we don't handle
  return false;
});

logger.info("Offscreen document script loaded");
