/**
 * FFmpeg offscreen document bridge
 *
 * Provides a single parameterized function that sends a processing request
 * to the offscreen document and waits for the response, replacing the
 * duplicated streamToMp4Blob / mergeToMp4 methods across handlers.
 */

import { CancellationError } from "./errors";
import { createOffscreenDocument } from "./offscreen-manager";
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

/**
 * Send a processing request to the offscreen document and return the blob URL.
 */
export async function processWithFFmpeg(
  options: ProcessWithFFmpegOptions,
): Promise<string> {
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

  return new Promise<string>((resolve, reject) => {
    // Check if already aborted before setting up listeners
    if (abortSignal?.aborted) {
      reject(new CancellationError());
      return;
    }

    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    let isSettled = false;

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

    const abortHandler = () => {
      if (isSettled) return;
      isSettled = true;
      cleanup();
      reject(new CancellationError());
    };

    const messageListener = (message: any) => {
      if (
        message.type === responseType &&
        message.payload?.downloadId === downloadId
      ) {
        const {
          type,
          blobUrl,
          error,
          progress,
          message: progressMessage,
        } = message.payload;

        if (type === "success") {
          if (isSettled) return;
          isSettled = true;
          cleanup();
          resolve(blobUrl);
        } else if (type === "error") {
          if (isSettled) return;
          isSettled = true;
          cleanup();
          reject(new Error(error || "FFmpeg processing failed"));
        } else if (type === "progress") {
          onProgress?.(progress, progressMessage || "");
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
          if (isSettled) return;
          isSettled = true;
          cleanup();
          reject(
            new Error(
              `Failed to send processing request: ${chrome.runtime.lastError.message}`,
            ),
          );
        }
      },
    );

    timeoutId = setTimeout(() => {
      if (isSettled) return;
      isSettled = true;
      if (abortSignal?.aborted) {
        cleanup();
        reject(new CancellationError());
        return;
      }
      cleanup();
      reject(new Error("FFmpeg processing timeout"));
    }, timeout);
  });
}
