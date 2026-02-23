/**
 * Background service worker for download orchestration
 * Handles download requests, state management, and CORS bypass for content scripts
 */

import { DownloadManager } from "./core/downloader/download-manager";
import { HlsRecordingHandler } from "./core/downloader/hls/hls-recording-handler";
import {
  getAllDownloads,
  getDownload,
  getDownloadByUrl,
  storeDownload,
  deleteDownload,
} from "./core/database/downloads";
import { ChromeStorage } from "./core/storage/chrome-storage";
import { MessageType } from "./shared/messages";
import {
  DownloadState,
  StorageConfig,
  VideoMetadata,
  DownloadStage,
} from "./core/types";
import { CancellationError } from "./core/utils/errors";
import { generateDownloadId } from "./core/utils/id-utils";
import { logger } from "./core/utils/logger";
import {
  canCancelDownload,
  CANNOT_CANCEL_MESSAGE,
} from "./core/utils/download-utils";
import { normalizeUrl, detectFormatFromUrl } from "./core/utils/url-utils";
import {
  generateFilenameWithExtension,
  generateFilenameFromTabInfo,
} from "./core/utils/file-utils";
import { deleteChunks, getChunkCount } from "./core/database/chunks";

const CONFIG_KEY = "storage_config";
const MAX_CONCURRENT_KEY = "max_concurrent";
const DEFAULT_FFMPEG_TIMEOUT = 900000; // 15 minutes in milliseconds (stored internally as ms)

const activeDownloads = new Map<string, Promise<void>>();
// Map to store AbortControllers for each download (keyed by normalized URL)
const downloadAbortControllers = new Map<string, AbortController>();
// Set of normalized URLs that should save partial progress on abort
const savePartialDownloads = new Set<string>();

/**
 * Keep-alive heartbeat mechanism to prevent service worker termination
 * Calls chrome.runtime.getPlatformInfo() every 20 seconds to keep worker alive
 * during long-running operations like downloads and FFmpeg processing
 * 
 * Source: https://stackoverflow.com/a/66618269
 */
const keepAlive = ((i?: ReturnType<typeof setInterval> | 0) => (state: boolean) => {
  if (state && !i) {
    // If service worker has been running for more than 20 seconds, call immediately
    if (performance.now() > 20e3) chrome.runtime.getPlatformInfo();
    i = setInterval(() => chrome.runtime.getPlatformInfo(), 20e3);
  } else if (!state && i) {
    clearInterval(i);
    i = 0;
  }
})();

/**
 * Initialize service worker
 */
async function init() {
  logger.info("Service worker initialized");
  chrome.runtime.onInstalled.addListener(handleInstallation);
}

/**
 * Handle extension installation
 */
function handleInstallation(details: chrome.runtime.InstalledDetails) {
  if (details.reason === "install") {
    logger.info("Extension installed");
  }
}

/**
 * Handle download request message
 */
async function handleDownloadRequestMessage(payload: {
  url: string;
  filename?: string;
  uploadToDrive?: boolean;
  metadata: VideoMetadata;
  tabTitle?: string;
  website?: string;
  manifestQuality?: {
    videoPlaylistUrl?: string | null;
    audioPlaylistUrl?: string | null;
  };
}): Promise<{ success: boolean; error?: string }> {
  try {
    const downloadResult = await handleDownloadRequest(payload);
    if (downloadResult && downloadResult.error) {
      return { success: false, error: downloadResult.error };
    }
    return { success: true };
  } catch (error) {
    logger.error("Download request error:", error);
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Handle get downloads message
 */
async function handleGetDownloadsMessage(): Promise<{
  success: boolean;
  data?: DownloadState[];
  error?: string;
}> {
  try {
    const downloads = await getAllDownloads();
    return { success: true, data: downloads };
  } catch (error) {
    logger.error("Get downloads error:", error);
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Handle cancel download message
 */
async function handleCancelDownloadMessage(
  id: string,
): Promise<{ success: boolean; error?: string }> {
  try {
    await handleCancelDownload(id);
    return { success: true };
  } catch (error) {
    logger.error("Cancel download error:", error);
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Handle get config message
 */
async function handleGetConfigMessage(): Promise<{
  success: boolean;
  data?: StorageConfig;
  error?: string;
}> {
  try {
    const config = await ChromeStorage.get<StorageConfig>(CONFIG_KEY);
    return { success: true, data: config || undefined };
  } catch (error) {
    logger.error("Get config error:", error);
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Handle save config message
 */
async function handleSaveConfigMessage(
  payload: StorageConfig,
): Promise<{ success: boolean; error?: string }> {
  try {
    await ChromeStorage.set(CONFIG_KEY, payload);
    return { success: true };
  } catch (error) {
    logger.error("Save config error:", error);
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Handle fetch resource message (CORS bypass)
 * Content scripts send fetch requests through service worker to bypass CORS
 */
async function handleFetchResourceMessage(payload: {
  input: string;
  init: {
    method?: string;
    headers?: Record<string, string>;
    body?: number[];
    mode?: RequestMode;
  };
}): Promise<
  [
    {
      body: number[];
      status: number;
      statusText: string;
      headers: Record<string, string>;
    } | null,
    Error | null,
  ]
> {
  try {
    const { input, init } = payload;

    let body: BodyInit | null = null;
    if (init.body) {
      body = new Uint8Array(init.body).buffer;
    }

    const fetchInit: RequestInit = {
      method: init.method || "GET",
      headers: init.headers || {},
      body: body,
      mode: init.mode,
    };

    const response = await fetch(input, fetchInit);
    const arrayBuffer = await response.arrayBuffer();

    const headersObj: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      headersObj[key] = value;
    });

    return [
      {
        body: Array.from(new Uint8Array(arrayBuffer)),
        status: response.status,
        statusText: response.statusText,
        headers: headersObj,
      },
      null,
    ];
  } catch (error) {
    return [null, error instanceof Error ? error : new Error(String(error))];
  }
}

/**
 * Set up network interceptor to detect video URLs
 * Intercepts completed network requests and sends valid video URLs to content scripts
 * Using onCompleted ensures the request has finished (better for autoplay scenarios)
 */
chrome.webRequest.onCompleted.addListener(
  (details) => {
    const url = details.url;
    logger.info(`Network request completed: ${url}`);
    // Detect if this is a video URL
    const format = detectFormatFromUrl(url);
    if (format === "unknown") {
      return;
    }

    // Send URL to content script in the tab that made the request
    if (details.tabId && details.tabId > 0) {
      chrome.tabs.sendMessage(
        details.tabId,
        {
          type: MessageType.NETWORK_URL_DETECTED,
          payload: { url },
        },
        (response) => {
          // Check for errors to prevent "unchecked runtime.lastError" warning
          if (chrome.runtime.lastError) {
            // Ignore - content script might not be available or tab closed
          }
        },
      );
    }
  },
  {
    urls: [
      "http://*/*.m3u8",
      "https://*/*.m3u8",
      "http://*/*.m3u8?*",
      "https://*/*.m3u8?*",
    ],
    types: ["xmlhttprequest"],
  },
  ["responseHeaders"],
);

/**
 * Handle messages from popup and content scripts
 * Processes download requests, state queries, config management, and CORS bypass requests
 */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  try {
    switch (message.type) {
      case MessageType.DOWNLOAD_REQUEST:
        handleDownloadRequestMessage(message.payload).then(sendResponse);
        return true; // Return true to indicate async response

      case MessageType.GET_DOWNLOADS:
        handleGetDownloadsMessage().then(sendResponse);
        return true;

      case MessageType.CANCEL_DOWNLOAD:
        handleCancelDownloadMessage(message.payload.id).then(sendResponse);
        return true;

      case MessageType.GET_CONFIG:
        handleGetConfigMessage().then(sendResponse);
        return true;

      case MessageType.SAVE_CONFIG:
        handleSaveConfigMessage(message.payload).then(sendResponse);
        return true;

      case MessageType.FETCH_RESOURCE:
        handleFetchResourceMessage(message.payload).then(sendResponse);
        return true;

      case MessageType.VIDEO_DETECTED:
        // This message is sent from content script to popup
        // Service worker doesn't need to handle it, just ignore silently
        return false;

      case MessageType.SET_ICON_BLUE:
        handleSetIconBlue(sender.tab?.id);
        return false;

      case MessageType.SET_ICON_GRAY:
        handleSetIconGray(sender.tab?.id);
        return false;

      case MessageType.START_RECORDING:
        handleStartRecordingMessage(message.payload).then(sendResponse);
        return true;

      case MessageType.STOP_RECORDING:
        handleStopRecordingMessage(message.payload).then(sendResponse);
        return true;

      case MessageType.STOP_AND_SAVE_DOWNLOAD:
        handleStopAndSaveMessage(message.payload).then(sendResponse);
        return true;

      case MessageType.OFFSCREEN_PROCESS_HLS_RESPONSE:
      case MessageType.OFFSCREEN_PROCESS_M3U8_RESPONSE:
        // Handled by ffmpeg-bridge's dynamic onMessage listener in processWithFFmpeg()
        return false;

      default:
        // Only log warnings for truly unknown message types
        // Some messages might be handled by other listeners (like content scripts)
        logger.warn(`Unknown message type: ${message.type}`);
        sendResponse({ success: false, error: "Unknown message type" });
        return false;
    }
  } catch (error) {
    logger.error("Message handling error:", error);
    sendResponse({
      success: false,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
});

async function cleanupOrphanedChunks(existing: DownloadState) {
  if (
    existing.metadata.format !== "hls" &&
    existing.metadata.format !== "m3u8"
  ) {
    return;
  }

  logger.info(
    `Cleaning up orphaned chunks for ${existing.progress.stage} download ${existing.id}`,
  );

  try {
    const chunkCount = await getChunkCount(existing.id);
    if (chunkCount > 0) {
      logger.warn(
        `Orphaned chunks found for ${existing.progress.stage} download ${existing.id}: ${chunkCount} chunks remaining`,
      );
      await deleteChunks(existing.id);
    } else {
      logger.info(
        `Successfully cleaned up orphaned chunks for ${existing.progress.stage} download ${existing.id}`,
      );
    }
  } catch (error) {
    logger.error(
      `Error verifying chunk cleanup for ${existing.progress.stage} download ${existing.id}:`,
      error,
    );
    // Don't throw - continue with download even if cleanup verification fails
  }
}

/**
 * Process download request
 * Validates request, checks for duplicates, creates download manager, and starts download
 */
async function handleDownloadRequest(payload: {
  url: string;
  filename?: string;
  uploadToDrive?: boolean;
  metadata: VideoMetadata;
  tabTitle?: string;
  website?: string;
  manifestQuality?: {
    videoPlaylistUrl?: string | null;
    audioPlaylistUrl?: string | null;
  };
  isManual?: boolean;
}): Promise<{ error?: string } | void> {
  const {
    url,
    filename,
    uploadToDrive,
    metadata,
    tabTitle,
    website,
    manifestQuality,
    isManual,
  } = payload;
  const normalizedUrl = normalizeUrl(url);
  const existing = await getDownloadByUrl(normalizedUrl);

  if (existing && existing.progress.stage === DownloadStage.COMPLETED) {
    logger.info(`Redownloading completed video: ${normalizedUrl}`);
    await deleteDownload(existing.id);
  }

  if (
    existing &&
    (existing.progress.stage === DownloadStage.FAILED ||
      existing.progress.stage === DownloadStage.CANCELLED)
  ) {
    logger.info(`Retrying failed or cancelled download: ${normalizedUrl}`);
    await deleteDownload(existing.id);
    // Also ensure it's removed from activeDownloads map
    activeDownloads.delete(normalizedUrl);

    await cleanupOrphanedChunks(existing);
  }

  if (activeDownloads.has(normalizedUrl)) {
    logger.info(`Download already in progress: ${normalizedUrl}`);
    return {
      error: "Download is already in progress. Please wait for it to complete.",
    };
  }

  const config = await ChromeStorage.get<StorageConfig>(CONFIG_KEY);
  const maxConcurrent =
    (await ChromeStorage.get<number>(MAX_CONCURRENT_KEY)) || 3;
  // FFmpeg timeout is stored in milliseconds (converted from minutes in settings UI)
  const ffmpegTimeout = config?.ffmpegTimeout || DEFAULT_FFMPEG_TIMEOUT;

  const downloadManager = new DownloadManager({
    maxConcurrent,
    ffmpegTimeout,
    shouldSaveOnCancel: () => savePartialDownloads.has(normalizedUrl),
    onProgress: async (state) => {
      // Use the pre-normalized URL from the outer scope instead of re-normalizing
      const normalizedUrlForProgress = normalizedUrl;

      // Get abort controller and store signal reference ONCE to avoid stale reference issues
      const controller = downloadAbortControllers.get(normalizedUrlForProgress);
      // Allow progress updates through if we're in stop-and-save mode (partial save in progress)
      const isSavingPartial = savePartialDownloads.has(normalizedUrlForProgress);

      // If no controller exists (already cleaned up) or signal is aborted, skip update
      // BUT allow updates through if we're saving a partial download
      if (!isSavingPartial && (!controller || controller.signal.aborted)) {
        logger.info(
          `Download ${state.id} was aborted, ignoring progress update`,
        );
        return;
      }

      // Store signal reference for consistent checks throughout this function
      const signal = controller?.signal;

      // Double-check cancellation state in database (defensive check)
      const currentState = await getDownload(state.id);
      // If download was deleted (cancelled) or has CANCELLED stage, don't update
      if (!currentState) {
        logger.info(
          `Download ${state.id} was deleted (cancelled), ignoring progress update`,
        );
        return;
      }
      if (currentState.progress.stage === DownloadStage.CANCELLED) {
        logger.info(
          `Download ${state.id} was cancelled, ignoring progress update`,
        );
        return;
      }

      // Final abort check immediately before storing to minimize race window
      // Re-check abort signal after async database operation using stored reference
      // Skip this check if we're saving a partial download
      if (!isSavingPartial && signal?.aborted) {
        logger.info(
          `Download ${state.id} was aborted, ignoring progress update`,
        );
        return;
      }

      await storeDownload(state);
      // Send progress update - handle errors gracefully (popup might be closed)
      try {
        chrome.runtime.sendMessage(
          {
            type: MessageType.DOWNLOAD_PROGRESS,
            payload: {
              id: state.id,
              progress: state.progress,
            },
          },
          () => {
            // Check for errors in callback
            if (chrome.runtime.lastError) {
              // Ignore - popup/content script might not be listening
            }
          },
        );
      } catch (error) {
        // Ignore errors - popup/content script might not be listening
      }
    },
    uploadToDrive: uploadToDrive || config?.googleDrive?.enabled || false,
  });

  // Create AbortController for this download to enable real-time cancellation
  const abortController = new AbortController();
  downloadAbortControllers.set(normalizedUrl, abortController);

  const downloadPromise = startDownload(
    downloadManager,
    url,
    filename,
    metadata,
    tabTitle,
    website,
    manifestQuality,
    isManual,
    abortController.signal, // Pass AbortSignal for real-time cancellation
  );
  activeDownloads.set(normalizedUrl, downloadPromise);

  // Start keep-alive if this is the first active download
  if (activeDownloads.size === 1) {
    keepAlive(true);
  }

  downloadPromise
    .then(async () => {
      await cleanupDownloadResources(normalizedUrl);
    })
    .catch(async (error: unknown) => {
      // Only log error if not cancelled
      if (error instanceof CancellationError) {
        // Cancellation already handled, don't log as error
        await cleanupDownloadResources(normalizedUrl);
        return;
      } else if (error instanceof Error) {
        logger.error(`Download failed for ${url}:`, error);
      } else {
        logger.error(`Download failed for ${url}:`, String(error));
      }
      await cleanupDownloadResources(normalizedUrl);
    })
    .finally(() => {
      // Ensure promise is removed from activeDownloads when it completes
      // This handles both success and failure cases
      activeDownloads.delete(normalizedUrl);
      
      // Stop keep-alive if no more active downloads
      if (activeDownloads.size === 0) {
        keepAlive(false);
      }
    });
}

/**
 * Send download completion message to popup
 */
function sendDownloadComplete(downloadId: string): void {
  try {
    chrome.runtime.sendMessage(
      {
        type: MessageType.DOWNLOAD_COMPLETE,
        payload: { id: downloadId },
      },
      () => {
        // Check for errors in callback
        if (chrome.runtime.lastError) {
          // Ignore - popup/content script might not be listening
        }
      },
    );
  } catch (error) {
    // Ignore errors - popup/content script might not be listening
  }
}

/**
 * Send download failure message to popup
 */
function sendDownloadFailed(url: string, error: string): void {
  try {
    chrome.runtime.sendMessage(
      {
        type: MessageType.DOWNLOAD_FAILED,
        payload: { url, error },
      },
      () => {
        // Check for errors in callback
        if (chrome.runtime.lastError) {
          // Ignore - popup/content script might not be listening
        }
      },
    );
  } catch (error) {
    // Ignore errors - popup/content script might not be listening
  }
}

/**
 * Check if download state indicates failure
 */
function isDownloadFailed(downloadState: DownloadState): boolean {
  return downloadState.progress.stage === DownloadStage.FAILED;
}

/**
 * Clean up download resources after completion or cancellation
 */
async function cleanupDownloadResources(normalizedUrl: string): Promise<void> {
  // Clean up AbortController
  downloadAbortControllers.delete(normalizedUrl);
  // Clean up stop-and-save marker
  savePartialDownloads.delete(normalizedUrl);

  // Note: activeDownloads cleanup is handled in the promise's finally block
  // to ensure it's removed regardless of success/failure/cancellation
}

/**
 * Cancel Chrome downloads associated with a download state
 * Only cancels if chromeDownloadId is set (direct downloads or HLS/M3U8 final save)
 */
async function cancelChromeDownloads(download: DownloadState): Promise<void> {
  // Only cancel if chromeDownloadId is set (Chrome downloads API is being used)
  // HLS/M3U8 downloads only use Chrome API at the final save stage
  if (download.chromeDownloadId === undefined) {
    logger.debug(
      `Skipping Chrome download cancellation - Chrome API not used for this download`,
    );
    return;
  }

  return new Promise((resolve) => {
    chrome.downloads.cancel(download.chromeDownloadId!, () => {
      if (chrome.runtime.lastError) {
        logger.debug(
          `Failed to cancel Chrome download ${download.chromeDownloadId}:`,
          chrome.runtime.lastError.message,
        );
      } else {
        logger.info(`Cancelled Chrome download ${download.chromeDownloadId}`);
      }
      resolve();
    });
  });
}

/**
 * Execute download using download manager
 * Sends completion or failure notifications to popup
 */
async function startDownload(
  downloadManager: DownloadManager,
  url: string,
  filename: string | undefined,
  metadata: VideoMetadata,
  tabTitle?: string,
  website?: string,
  manifestQuality?: {
    videoPlaylistUrl?: string | null;
    audioPlaylistUrl?: string | null;
  },
  isManual?: boolean,
  abortSignal?: AbortSignal,
): Promise<void> {
  try {
    // Generate filename if not provided
    let finalFilename = filename;
    if (!finalFilename) {
      // HLS/M3U8 formats always produce MP4 after FFmpeg processing
      const extension = metadata.format === "hls" || metadata.format === "m3u8"
        ? "mp4"
        : metadata.fileExtension || "mp4";
      // Use tab info if available, otherwise fall back to URL-based generation
      if (tabTitle || website) {
        finalFilename = generateFilenameFromTabInfo(
          tabTitle,
          website,
          extension,
        );
      } else {
        finalFilename = generateFilenameWithExtension(url, extension);
      }
    }

    const downloadState = await downloadManager.download(
      url,
      finalFilename,
      metadata,
      manifestQuality,
      isManual,
      abortSignal,
    );

    // Handle failed downloads (e.g., unknown format)
    if (isDownloadFailed(downloadState)) {
      const errorMessage = downloadState.progress.error || "Download failed";
      sendDownloadFailed(url, errorMessage);
      return;
    }

    // Handle successful downloads
    sendDownloadComplete(downloadState.id);
  } catch (error) {
    logger.error(`Download process failed for ${url}:`, error);

    const errorMessage = error instanceof Error ? error.message : String(error);

    sendDownloadFailed(url, errorMessage);
    throw error;
  }
}

/**
 * Stop an active HLS/M3U8 download and save whatever segments have been downloaded so far
 */
async function handleStopAndSaveMessage(payload: {
  url: string;
}): Promise<{ success: boolean; error?: string }> {
  try {
    const normalizedUrl = normalizeUrl(payload.url);
    const controller = downloadAbortControllers.get(normalizedUrl);
    if (!controller) {
      return { success: false, error: "No active download found for this URL." };
    }
    savePartialDownloads.add(normalizedUrl);
    controller.abort();
    logger.info(`Stop-and-save triggered for ${normalizedUrl}`);
    return { success: true };
  } catch (error) {
    logger.error("Stop-and-save error:", error);
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Cancel active download
 * Removes from active downloads map, cancels Chrome downloads, and deletes the download
 * This resets the UI to initial state (video card shows as just detected)
 */
async function handleCancelDownload(id: string): Promise<void> {
  const download = await getDownload(id);
  if (!download) {
    return;
  }

  // Prevent cancellation during merging or saving phases
  // Chunks are already downloaded at this point, so cancellation would waste resources
  if (!canCancelDownload(download.progress.stage)) {
    logger.info(
      `Cancellation prevented for download ${id}: ${CANNOT_CANCEL_MESSAGE}`,
    );
    throw new Error(CANNOT_CANCEL_MESSAGE);
  }

  const normalizedUrl = normalizeUrl(download.url);

  // 1. Abort fetch operations
  const abortController = downloadAbortControllers.get(normalizedUrl);
  if (abortController) {
    abortController.abort();
    logger.info(`Aborted fetch operations for download ${normalizedUrl}`);
    downloadAbortControllers.delete(normalizedUrl);
  }

  // 2. Cancel Chrome downloads
  await cancelChromeDownloads(download);

  // 3. Clean up chunks for HLS/M3U8 downloads
  // Only cleanup if format is HLS or M3U8 (these use IndexedDB chunks)
  if (
    download.metadata.format === "hls" ||
    download.metadata.format === "m3u8"
  ) {
    try {
      await deleteChunks(download.id);
      logger.info(`Cleaned up chunks for cancelled download ${download.id}`);
    } catch (error) {
      logger.error(
        `Failed to clean up chunks for download ${download.id}:`,
        error,
      );
      // Don't throw - continue with cancellation even if cleanup fails
    }
  }

  // 4. Delete the download from database to reset UI to initial state
  // This removes the download from the downloads list and shows the video card
  // in the detected videos list as if it was just detected
  await deleteDownload(download.id);

  // Note: activeDownloads cleanup is handled in the promise's finally block
  // We don't remove it here to avoid race conditions - let the promise complete
  // and clean itself up. The abort signal will cause the download to stop.

  logger.info(`Download cancelled and removed: ${id}`);
}

/**
 * Start live HLS recording
 */
async function handleStartRecordingMessage(payload: {
  url: string;
  metadata: VideoMetadata;
  filename?: string;
  tabTitle?: string;
  website?: string;
}): Promise<{ success: boolean; error?: string }> {
  try {
    const { url, metadata, filename, tabTitle, website } = payload;
    const normalizedUrl = normalizeUrl(url);

    if (activeDownloads.has(normalizedUrl)) {
      return { success: false, error: "Recording already in progress for this URL." };
    }

    const config = await ChromeStorage.get<StorageConfig>(CONFIG_KEY);
    const maxConcurrent =
      (await ChromeStorage.get<number>(MAX_CONCURRENT_KEY)) || 3;
    const ffmpegTimeout = config?.ffmpegTimeout || DEFAULT_FFMPEG_TIMEOUT;

    // Build initial download state
    const stateId = generateDownloadId(normalizedUrl);
    const initialState: DownloadState = {
      id: stateId,
      url,
      metadata,
      progress: {
        url,
        stage: DownloadStage.RECORDING,
        segmentsCollected: 0,
        message: "Recording...",
      },
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    await storeDownload(initialState);

    const abortController = new AbortController();
    downloadAbortControllers.set(normalizedUrl, abortController);

    const onProgress = async (state: DownloadState) => {
      const controller = downloadAbortControllers.get(normalizeUrl(state.url));
      // Allow progress updates through when in post-recording stages (MERGING, SAVING, COMPLETED)
      // since the abort signal is used to stop the recording loop, not to cancel the merge
      const isPostRecording =
        state.progress.stage === DownloadStage.MERGING ||
        state.progress.stage === DownloadStage.SAVING ||
        state.progress.stage === DownloadStage.COMPLETED;
      if (!isPostRecording && (!controller || controller.signal.aborted)) return;
      await storeDownload(state);
      try {
        chrome.runtime.sendMessage(
          {
            type: MessageType.DOWNLOAD_PROGRESS,
            payload: { id: state.id, progress: state.progress },
          },
          () => { if (chrome.runtime.lastError) {} },
        );
      } catch (_) {}
    };

    const handler = new HlsRecordingHandler({
      onProgress,
      maxConcurrent,
      ffmpegTimeout,
    });

    // Resolve filename
    let finalFilename = filename;
    if (!finalFilename) {
      // HLS/M3U8 formats always produce MP4 after FFmpeg processing
      const extension = metadata.format === "hls" || metadata.format === "m3u8"
        ? "mp4"
        : metadata.fileExtension || "mp4";
      if (tabTitle || website) {
        finalFilename = generateFilenameFromTabInfo(tabTitle, website, extension);
      } else {
        finalFilename = generateFilenameWithExtension(url, extension);
      }
    }

    const recordingPromise = handler
      .record(url, finalFilename, stateId, abortController.signal, metadata.pageUrl)
      .then(async () => {
        await cleanupDownloadResources(normalizedUrl);
        sendDownloadComplete(stateId);
      })
      .catch(async (error: unknown) => {
        // Persist FAILED state to IndexedDB so the downloads tab reflects the real status
        const failedState = await getDownload(stateId);
        if (failedState && failedState.progress.stage !== DownloadStage.COMPLETED) {
          failedState.progress.stage = DownloadStage.FAILED;
          failedState.progress.message =
            error instanceof Error ? error.message : String(error);
          failedState.updatedAt = Date.now();
          await storeDownload(failedState);
        }
        if (!(error instanceof CancellationError)) {
          logger.error(`Recording failed for ${url}:`, error);
          sendDownloadFailed(url, error instanceof Error ? error.message : String(error));
        }
        await cleanupDownloadResources(normalizedUrl);
      })
      .finally(() => {
        activeDownloads.delete(normalizedUrl);
        if (activeDownloads.size === 0) keepAlive(false);
      });

    activeDownloads.set(normalizedUrl, recordingPromise);
    if (activeDownloads.size === 1) keepAlive(true);

    return { success: true };
  } catch (error) {
    logger.error("Start recording error:", error);
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Stop live HLS recording (triggers merge + save inside handler)
 */
async function handleStopRecordingMessage(payload: {
  url: string;
}): Promise<{ success: boolean; error?: string }> {
  try {
    const normalizedUrl = normalizeUrl(payload.url);
    const abortController = downloadAbortControllers.get(normalizedUrl);
    if (!abortController) {
      return { success: false, error: "No active recording found for this URL." };
    }
    abortController.abort();
    logger.info(`Stopped recording for ${normalizedUrl}`);
    return { success: true };
  } catch (error) {
    logger.error("Stop recording error:", error);
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Set extension icon to blue
 */
async function handleSetIconBlue(tabId?: number): Promise<void> {
  try {
    const iconPaths = {
      16: "icons/icon-16.png",
      48: "icons/icon-48.png",
      128: "icons/icon-128.png",
    };

    if (tabId) {
      // Set icon for specific tab
      await chrome.action.setIcon({
        tabId,
        path: iconPaths,
      });
    } else {
      // Set icon globally
      await chrome.action.setIcon({
        path: iconPaths,
      });
    }
  } catch (error) {
    logger.error("Failed to set blue icon:", error);
  }
}

/**
 * Set extension icon to gray
 */
async function handleSetIconGray(tabId?: number): Promise<void> {
  try {
    const iconPaths = {
      16: "icons/icon-gray-16.png",
      48: "icons/icon-gray-48.png",
      128: "icons/icon-gray-128.png",
    };

    if (tabId) {
      // Set icon for specific tab
      await chrome.action.setIcon({
        tabId,
        path: iconPaths,
      });
    } else {
      // Set icon globally
      await chrome.action.setIcon({
        path: iconPaths,
      });
    }
  } catch (error) {
    logger.error("Failed to set gray icon:", error);
  }
}

// Initialize service worker
init().catch((error) => {
  logger.error("Service worker initialization failed:", error);
});
