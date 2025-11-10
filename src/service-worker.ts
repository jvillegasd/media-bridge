/**
 * Background service worker for download orchestration
 * Handles download requests, state management, and CORS bypass for content scripts
 */

import { DownloadManager } from "./core/downloader/download-manager";
import { DownloadStateManager } from "./core/storage/download-state";
import { ChromeStorage } from "./core/storage/chrome-storage";
import { MessageType } from "./shared/messages";
import { DownloadState, StorageConfig, VideoMetadata } from "./core/types";
import { logger } from "./core/utils/logger";
import { normalizeUrl } from "./core/utils/url-utils";

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
    // Open options page on first install
    chrome.runtime.openOptionsPage();
  }
}

/**
 * Handle download request message
 */
async function handleDownloadRequestMessage(payload: {
  url: string;
  filename?: string;
  uploadToDrive?: boolean;
  metadata?: VideoMetadata;
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
    const downloads = await DownloadStateManager.getAllDownloads();
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
        // CORS bypass: content scripts send fetch requests through service worker
        (async () => {
          try {
            const { input, init } = message.payload;
            
            let body: BodyInit | null = null;
            if (init.body) {
              body = new Uint8Array(init.body).buffer;
            }
            
            const fetchInit: RequestInit = {
              method: init.method || 'GET',
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

            sendResponse([
              {
                body: Array.from(new Uint8Array(arrayBuffer)),
                status: response.status,
                statusText: response.statusText,
                headers: headersObj,
              },
              null,
            ]);
          } catch (error) {
            sendResponse([
              null,
              error instanceof Error ? error : new Error(String(error)),
            ]);
          }
        })();
        return true;

      default:
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
  metadata?: VideoMetadata;
}): Promise<{ error?: string } | void> {
  const { url, filename, uploadToDrive, metadata } = payload;
  const normalizedUrl = normalizeUrl(url);
  const existing = await DownloadStateManager.getDownloadByUrl(normalizedUrl);

  if (existing && existing.progress.stage === "completed") {
    logger.info(`Redownloading completed video: ${normalizedUrl}`);
    await DownloadStateManager.removeDownload(existing.id);
  }

  if (existing && existing.progress.stage === "failed") {
    logger.info(`Retrying failed download: ${normalizedUrl}`);
    await DownloadStateManager.removeDownload(existing.id);
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
      await DownloadStateManager.saveDownload(state);
      try {
        await chrome.runtime.sendMessage({
          type: MessageType.DOWNLOAD_PROGRESS,
          payload: {
            id: state.id,
            progress: state.progress,
          },
        });
      } catch (error) {
        // No listeners available
      }
    },
    uploadToDrive: uploadToDrive || config?.googleDrive?.enabled || false,
  });

  const downloadPromise = startDownload(
    downloadManager,
    url,
    filename,
    metadata,
  );
  activeDownloads.set(normalizedUrl, downloadPromise);

  downloadPromise
    .then(() => {
      activeDownloads.delete(normalizedUrl);
    })
    .catch((error: any) => {
      logger.error(`Download failed for ${url}:`, error);
      activeDownloads.delete(normalizedUrl);
    });
}

/**
 * Execute download using download manager
 * Sends completion or failure notifications to popup
 */
async function startDownload(
  downloadManager: DownloadManager,
  url: string,
  filename?: string,
  metadata?: VideoMetadata,
): Promise<void> {
  try {
    const downloadState = await downloadManager.download(
      url,
      filename,
      metadata,
    );

    try {
      await chrome.runtime.sendMessage({
        type: MessageType.DOWNLOAD_COMPLETE,
        payload: { id: downloadState.id },
      });
    } catch (error) {
      // No listeners available
    }
  } catch (error) {
    logger.error(`Download process failed for ${url}:`, error);

    try {
      await chrome.runtime.sendMessage({
        type: MessageType.DOWNLOAD_FAILED,
        payload: {
          url,
          error: error instanceof Error ? error.message : String(error),
        },
      });
    } catch (err) {
      // No listeners available
    }

    throw error;
  }
}

/**
 * Cancel active download
 * Removes from active downloads map and marks state as failed
 */
async function handleCancelDownload(id: string) {
  const download = await DownloadStateManager.getDownload(id);
  if (!download) {
    return;
  }

  const normalizedUrl = normalizeUrl(download.url);
  activeDownloads.delete(normalizedUrl);

  download.progress.stage = "failed";
  download.progress.error = "Cancelled by user";
  await DownloadStateManager.saveDownload(download);

  logger.info(`Download cancelled: ${id}`);
}


// Initialize service worker
init().catch((error) => {
  logger.error("Service worker initialization failed:", error);
});

