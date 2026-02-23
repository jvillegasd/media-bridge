/**
 * FFmpeg offscreen document bridge
 *
 * Provides a single parameterized function that sends a processing request
 * to the offscreen document and waits for the response, replacing the
 * duplicated streamToMp4Blob / mergeToMp4 methods across handlers.
 */

import { CancellationError } from "./errors";
import { createOffscreenDocument } from "./offscreen-manager";
import { revokeBlobUrl } from "./blob-utils";
import { MessageType } from "../../shared/messages";

export interface ProcessWithFFmpegOptions {
  /** Message type to send (e.g. OFFSCREEN_PROCESS_HLS) */
  requestType: MessageType;
  /** Response message type to listen for */
  responseType: MessageType;
  /** Download ID used to correlate request/response */
  downloadId: string;
  /** Handler-specific payload fields (merged into the message payload) */
  payload: Record<string, unknown>;
  /** Output filename (without extension) */
  filename: string;
  /** Timeout in ms before rejecting */
  timeout: number;
  /** Optional abort signal for cancellation */
  abortSignal?: AbortSignal;
  /** Optional progress callback (progress 0-1, message string) */
  onProgress?: (progress: number, message: string) => void;
}

export interface ProcessWithFFmpegResult {
  blobUrl: string;
  /** Warning about missing chunks, if any */
  warning?: string;
}

/** Discriminated union for FFmpeg response message payloads */
interface FFmpegResponsePayload {
  downloadId: string;
  type: "success" | "error" | "progress";
  blobUrl?: string;
  warning?: string;
  error?: string;
  progress?: number;
  message?: string;
}

interface FFmpegResponseMessage {
  type: MessageType;
  payload: FFmpegResponsePayload;
}

/**
 * Send a processing request to the offscreen document and return the blob URL.
 */
export async function processWithFFmpeg(
  options: ProcessWithFFmpegOptions,
): Promise<ProcessWithFFmpegResult> {
  const {
    requestType,
    responseType,
    downloadId,
    payload,
    filename,
    timeout,
    abortSignal,
    onProgress,
  } = options;

  await createOffscreenDocument();

  return new Promise<ProcessWithFFmpegResult>((resolve, reject) => {
    // Check if already aborted before setting up listeners
    if (abortSignal?.aborted) {
      reject(new CancellationError());
      return;
    }

    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    let isSettled = false;

    /** Revokes blob URLs from late-arriving success messages after timeout/abort. */
    const cleanupListener = (message: FFmpegResponseMessage) => {
      if (
        message.type === responseType &&
        message.payload?.downloadId === downloadId &&
        message.payload.type === "success" &&
        message.payload.blobUrl
      ) {
        revokeBlobUrl(message.payload.blobUrl);
        chrome.runtime.onMessage.removeListener(cleanupListener);
      }
    };

    const cleanup = () => {
      if (timeoutId) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }
      chrome.runtime.onMessage.removeListener(messageListener);
      if (abortSignal) {
        abortSignal.removeEventListener("abort", abortHandler);
      }
    };

    const settle = (error: Error) => {
      if (isSettled) return;
      isSettled = true;
      cleanup();
      chrome.runtime.onMessage.addListener(cleanupListener);
      reject(error);
    };

    const abortHandler = () => {
      settle(new CancellationError());
    };

    /** Handles success/error/progress during active processing. */
    const messageListener = (message: FFmpegResponseMessage) => {
      if (
        message.type === responseType &&
        message.payload?.downloadId === downloadId
      ) {
        const {
          type,
          blobUrl,
          warning,
          error,
          progress,
          message: progressMessage,
        } = message.payload;

        if (type === "success") {
          if (isSettled) return;
          isSettled = true;
          cleanup();
          resolve({ blobUrl: blobUrl!, warning });
        } else if (type === "error") {
          if (isSettled) return;
          isSettled = true;
          cleanup();
          reject(new Error(error || "FFmpeg processing failed"));
        } else if (type === "progress") {
          onProgress?.(progress ?? 0, progressMessage || "");
        }
      }
    };

    chrome.runtime.onMessage.addListener(messageListener);

    if (abortSignal) {
      abortSignal.addEventListener("abort", abortHandler);
    }

    chrome.runtime.sendMessage(
      {
        type: requestType,
        payload: {
          downloadId,
          filename,
          ...payload,
        },
      },
      () => {
        if (chrome.runtime.lastError) {
          settle(
            new Error(
              `Failed to send processing request: ${chrome.runtime.lastError.message}`,
            ),
          );
        }
      },
    );

    timeoutId = setTimeout(() => {
      if (abortSignal?.aborted) {
        settle(new CancellationError());
        return;
      }
      settle(new Error("FFmpeg processing timeout"));
    }, timeout);
  });
}
