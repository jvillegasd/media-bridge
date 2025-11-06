/**
 * Client for communicating with offscreen document for FFmpeg merging
 */

import { MessageType } from '../shared/messages';
import { logger } from '../core/utils/logger';

/**
 * Ensure offscreen document is created
 */
export async function ensureOffscreenDocument(): Promise<void> {
  if (!chrome.offscreen) {
    throw new Error('Offscreen API not available');
  }

  const hasDocument = await chrome.offscreen.hasDocument?.();
  if (hasDocument) {
    return;
  }

  // Create offscreen document
  // Use 'IFRAME_SCRIPTING' for FFmpeg.wasm execution
  await chrome.offscreen.createDocument({
    url: 'offscreen/offscreen.html',
    reasons: [chrome.offscreen.Reason.WORKERS],
    justification: 'FFmpeg-based HLS audio/video merging',
  });

  logger.info('Offscreen document created for FFmpeg merging');
}

/**
 * Close offscreen document
 */
export async function closeOffscreenDocument(): Promise<void> {
  if (!chrome.offscreen) {
    return;
  }

  const hasDocument = await chrome.offscreen.hasDocument?.();
  if (hasDocument) {
    await chrome.offscreen.closeDocument();
  }
}

/**
 * Request merge of video and audio segments using FFmpeg
 */
export async function mergeVideoAudio(
  videoSegments: ArrayBuffer[],
  audioSegments: ArrayBuffer[],
  onProgress?: (progress: number, message: string) => void
): Promise<ArrayBuffer> {
  await ensureOffscreenDocument();

  return new Promise((resolve, reject) => {
    // Listen for progress updates from offscreen document
    const progressListener = (message: any) => {
      if (message?.type === MessageType.OFFSCREEN_MERGE_REQUEST && message?.progress) {
        const { progress: progressValue, message: progressMessage } = message;
        onProgress?.(progressValue, progressMessage || 'Processing...');
      }
    };

    chrome.runtime.onMessage.addListener(progressListener);

    // Send merge request
    chrome.runtime.sendMessage(
      {
        type: MessageType.OFFSCREEN_MERGE_REQUEST,
        payload: {
          videoSegments,
          audioSegments,
        },
      },
      (response) => {
        chrome.runtime.onMessage.removeListener(progressListener);

        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }

        if (!response) {
          reject(new Error('No response from offscreen document'));
          return;
        }

        if (!response.success) {
          reject(new Error(response.error || 'Merge failed'));
          return;
        }

        resolve(response.data);
      }
    );
  });
}


