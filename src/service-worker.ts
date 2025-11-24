/**
 * Background service worker for download orchestration
 * Handles download requests, state management, and CORS bypass for content scripts
 */

import { DownloadManager } from "./core/downloader/download-manager";
import {
  getAllDownloads,
  getDownload,
  getDownloadByUrl,
  storeDownload,
  deleteDownload,
} from "./core/storage/indexeddb-downloads";
import { ChromeStorage } from "./core/storage/chrome-storage";
import { MessageType } from "./shared/messages";
import { DownloadState, StorageConfig, VideoMetadata } from "./core/types";
import { logger } from "./core/utils/logger";
import { normalizeUrl, detectFormatFromUrl } from "./core/utils/url-utils";
import {
  generateFilenameWithExtension,
  generateFilenameFromTabInfo,
} from "./core/utils/file-utils";

const CONFIG_KEY = "storage_config";
const MAX_CONCURRENT_KEY = "max_concurrent";

const activeDownloads = new Map<string, Promise<void>>();

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

  if (existing && existing.progress.stage === "completed") {
    logger.info(`Redownloading completed video: ${normalizedUrl}`);
    await deleteDownload(existing.id);
  }

  if (existing && existing.progress.stage === "cancelled") {
    // Don't auto-retry cancelled downloads
    logger.info(`Download was cancelled, not retrying: ${normalizedUrl}`);
    return {
      error: "Download was cancelled. Please start a new download.",
    };
  }

  if (existing && existing.progress.stage === "failed") {
    logger.info(`Retrying failed download: ${normalizedUrl}`);
    await deleteDownload(existing.id);
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

  const downloadManager = new DownloadManager({
    maxConcurrent,
    onProgress: async (state) => {
      // Check if download was cancelled before updating state
      const currentState = await getDownload(state.id);
      if (currentState && currentState.progress.stage === "cancelled") {
        // Download was cancelled, don't update state
        logger.info(`Download ${state.id} was cancelled, ignoring progress update`);
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

  const downloadPromise = startDownload(
    downloadManager,
    url,
    filename,
    metadata,
    tabTitle,
    website,
    manifestQuality,
    isManual,
  );
  activeDownloads.set(normalizedUrl, downloadPromise);

  downloadPromise
    .then(async () => {
      activeDownloads.delete(normalizedUrl);
      // Check if download was cancelled before marking as complete
      const finalState = await getDownloadByUrl(normalizedUrl);
      if (finalState && finalState.progress.stage === "cancelled") {
        logger.info(`Download ${normalizedUrl} was cancelled, not marking as complete`);
        return;
      }
    })
    .catch(async (error: any) => {
      logger.error(`Download failed for ${url}:`, error);
      activeDownloads.delete(normalizedUrl);
      // Check if download was cancelled - if so, don't update error
      const finalState = await getDownloadByUrl(normalizedUrl);
      if (finalState && finalState.progress.stage === "cancelled") {
        logger.info(`Download ${normalizedUrl} was cancelled, keeping cancellation status`);
        return;
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
  return downloadState.progress.stage === "failed";
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
): Promise<void> {
  try {
    // Generate filename if not provided
    let finalFilename = filename;
    if (!finalFilename) {
      const extension = metadata.fileExtension || "mp4";
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
 * Cancel active download
 * Removes from active downloads map, cancels Chrome downloads, and marks state as failed
 */
async function handleCancelDownload(id: string) {
  const download = await getDownload(id);
  if (!download) {
    return;
  }

  const normalizedUrl = normalizeUrl(download.url);
  
  // Remove from active downloads map (this prevents the promise from completing)
  activeDownloads.delete(normalizedUrl);

  // Cancel any Chrome downloads associated with this download
  // For direct downloads, we can find and cancel the Chrome download
  // For HLS/M3U8, fragments are downloaded via fetch, so we mark as cancelled
  // and the handlers will check for cancellation status
  try {
    // Search for Chrome downloads that match this download's filename or URL
    const filename = download.localPath
      ? download.localPath.split(/[/\\]/).pop()
      : undefined;

    if (filename) {
      // Try to find and cancel Chrome downloads by filename
      chrome.downloads.search(
        { filenameRegex: filename.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") },
        (results) => {
          if (results && results.length > 0) {
            // Cancel all matching downloads
            results.forEach((item) => {
              if (item.state === "in_progress") {
                chrome.downloads.cancel(item.id, () => {
                  if (chrome.runtime.lastError) {
                    logger.debug(
                      `Failed to cancel Chrome download ${item.id}:`,
                      chrome.runtime.lastError.message,
                    );
                  } else {
                    logger.info(`Cancelled Chrome download ${item.id}`);
                  }
                });
              }
            });
          }
        },
      );
    }

    // Also try searching by URL
    chrome.downloads.search({ url: download.url }, (results) => {
      if (results && results.length > 0) {
        results.forEach((item) => {
          if (item.state === "in_progress") {
            chrome.downloads.cancel(item.id, () => {
              if (chrome.runtime.lastError) {
                logger.debug(
                  `Failed to cancel Chrome download ${item.id}:`,
                  chrome.runtime.lastError.message,
                );
              } else {
                logger.info(`Cancelled Chrome download ${item.id}`);
              }
            });
          }
        });
      }
    });
  } catch (error) {
    logger.error("Error cancelling Chrome downloads:", error);
  }

  // Mark download as cancelled
  download.progress.stage = "cancelled";
  download.progress.error = "Cancelled by user";
  await storeDownload(download);

  logger.info(`Download cancelled: ${id}`);
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
