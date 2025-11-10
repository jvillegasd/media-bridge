/**
 * Background service worker for download orchestration
 */

import { DownloadManager } from "./core/downloader/download-manager";
import { DownloadStateManager } from "./core/storage/download-state";
import { UploadManager } from "./core/cloud/upload-manager";
import { ChromeStorage } from "./core/storage/chrome-storage";
import { MessageType } from "./shared/messages";
import { DownloadState, StorageConfig, VideoMetadata } from "./core/types";
import { logger } from "./core/utils/logger";
import { normalizeUrl } from "./core/utils/url-utils";
import { FormatDetector } from "./core/detection/format-detector";

// Configuration keys
const CONFIG_KEY = "storage_config";
const MAX_CONCURRENT_KEY = "max_concurrent";

// Active downloads
const activeDownloads = new Map<string, Promise<void>>();

/**
 * Initialize service worker
 */
async function init() {
  logger.info("Service worker initialized");

  // Handle messages - now handled directly in addListener with async function
  // (see handleMessage function below)

  // Handle extension installation
  chrome.runtime.onInstalled.addListener(handleInstallation);

  // Set up video detection via webRequest
  setupVideoDetection();
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

      case MessageType.VIDEO_DETECTED:
        // Video detection messages are sent from content scripts to popup
        // Service worker doesn't need to handle these, but we'll acknowledge receipt
        // The popup will request detected videos via GET_DETECTED_VIDEOS when needed
        sendResponse({ success: true });
        return false; // Don't keep channel open, popup handles this directly

      case MessageType.GET_DETECTED_VIDEOS:
      case MessageType.CLEAR_DETECTED_VIDEOS:
      case MessageType.START_DOWNLOAD:
        // These messages are handled by content scripts or popup directly
        // Service worker doesn't need to handle them
        sendResponse({ success: true });
        return false;

      case MessageType.FETCH_RESOURCE:
        // Handle fetch request from content script (for CORS bypass)
        (async () => {
          try {
            const { input, init } = message.payload;
            
            // Convert body array back to ArrayBuffer if present
            let body: BodyInit | null = null;
            if (init.body) {
              body = new Uint8Array(init.body).buffer;
            }
            
            // Reconstruct init object
            const fetchInit: RequestInit = {
              method: init.method || 'GET',
              headers: init.headers || {},
              body: body,
              mode: init.mode,
              credentials: init.credentials,
              cache: init.cache,
              redirect: init.redirect,
              referrer: init.referrer,
              referrerPolicy: init.referrerPolicy,
              integrity: init.integrity,
            };

            // Add timeout if specified (using AbortSignal.timeout)
            if (init.timeout) {
              fetchInit.signal = AbortSignal.timeout(init.timeout);
            }

            const response = await fetch(input, fetchInit);
            
            // Get response text
            const text = await response.text();
            
            // Convert headers to plain object
            const headersObj: Record<string, string> = {};
            response.headers.forEach((value, key) => {
              headersObj[key] = value;
            });

            sendResponse([
              {
                body: text,
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
        return true; // Keep channel open for async response

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
 * Handle download request
 */
async function handleDownloadRequest(payload: {
  url: string;
  filename?: string;
  uploadToDrive?: boolean;
  metadata?: VideoMetadata;
}): Promise<{ error?: string } | void> {
  const { url, filename, uploadToDrive, metadata } = payload;

  // Normalize URL for comparison (remove hash fragments)
  const normalizedUrl = normalizeUrl(url);

  // Check for existing download - use URL as the key
  const existing = await DownloadStateManager.getDownloadByUrl(normalizedUrl);

  // Allow redownloading completed videos - remove old state first
  if (existing && existing.progress.stage === "completed") {
    logger.info(
      `Redownloading completed video for URL: ${normalizedUrl}`,
    );
    await DownloadStateManager.removeDownload(existing.id);
  }

  // If download exists but failed, allow retry by removing old state
  if (existing && existing.progress.stage === "failed") {
    logger.info(`Retrying failed download for URL: ${normalizedUrl}`);
    await DownloadStateManager.removeDownload(existing.id);
  }

  // Check if download is already in progress (by URL)
  if (activeDownloads.has(normalizedUrl)) {
    logger.info(
      `Download already in progress for URL: ${normalizedUrl}`,
    );
    return {
      error:
        "Download is already in progress. Please wait for it to complete.",
    };
  }

  // Get configuration
  const config = await ChromeStorage.get<StorageConfig>(CONFIG_KEY);
  const maxConcurrent =
    (await ChromeStorage.get<number>(MAX_CONCURRENT_KEY)) || 3;

  // Create download manager
  const downloadManager = new DownloadManager({
    maxConcurrent,
    onProgress: async (state) => {
      await DownloadStateManager.saveDownload(state);

      // Broadcast progress update
      try {
        await chrome.runtime.sendMessage({
          type: MessageType.DOWNLOAD_PROGRESS,
          payload: {
            id: state.id,
            progress: state.progress,
          },
        });
      } catch (error) {
        // Ignore errors if no listeners
      }
    },
    uploadToDrive: uploadToDrive || config?.googleDrive?.enabled || false,
  });

  // Note: Upload manager would be created here if we implement upload-before-save
  // For now, uploads would need to be handled separately or we'd need to modify
  // the download flow to upload before saving to disk

  // Start download (use normalized URL as key to prevent duplicates with different hash fragments)
  const downloadPromise = startDownload(
    downloadManager,
    undefined,
    url,
    filename,
    metadata,
  );
  activeDownloads.set(normalizedUrl, downloadPromise);

  // Clean up when done
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
 * Start download process
 */
async function startDownload(
  downloadManager: DownloadManager,
  uploadManager: UploadManager | undefined,
  url: string,
  filename?: string,
  metadata?: VideoMetadata,
): Promise<void> {
  try {
    // Download video
    const downloadState = await downloadManager.download(
      url,
      filename,
      metadata,
    );

    // Note: Upload functionality would require storing the blob during download
    // or uploading before saving to disk. For now, uploads are not automatically
    // triggered after download completes due to file system access limitations

    // Notify completion
    try {
      await chrome.runtime.sendMessage({
        type: MessageType.DOWNLOAD_COMPLETE,
        payload: {
          id: downloadState.id,
        },
      });
    } catch (error) {
      // Ignore errors
    }
  } catch (error) {
    logger.error(`Download process failed for ${url}:`, error);

    // Notify failure
    try {
      await chrome.runtime.sendMessage({
        type: MessageType.DOWNLOAD_FAILED,
        payload: {
          url,
          error: error instanceof Error ? error.message : String(error),
        },
      });
    } catch (err) {
      // Ignore errors
    }

    throw error;
  }
}

/**
 * Handle cancel download
 */
async function handleCancelDownload(id: string) {
  const download = await DownloadStateManager.getDownload(id);
  if (!download) {
    return;
  }

  // Remove from active downloads (use normalized URL)
  const normalizedUrl = normalizeUrl(download.url);
  activeDownloads.delete(normalizedUrl);

  // Update state
  download.progress.stage = "failed";
  download.progress.error = "Cancelled by user";
  await DownloadStateManager.saveDownload(download);

  logger.info(`Download cancelled: ${id}`);
}

/**
 * Set up video detection using webRequest API
 * Uses FormatDetector to abstract format detection logic
 */
function setupVideoDetection() {
  // Listen for completed network requests
  chrome.webRequest.onCompleted.addListener(
    async (details) => {
      // Skip requests without a tab (background requests)
      if (details.tabId < 0) {
        return;
      }

      // Check status code
      if (
        details.statusCode &&
        (details.statusCode < 200 || details.statusCode >= 300)
      ) {
        return;
      }

      // Extract content-type header
      const contentTypeHeader = details.responseHeaders?.find(
        (h) => h.name.toLowerCase() === "content-type",
      );

      const contentType = contentTypeHeader?.value || "";

      // Use FormatDetector to detect format from headers and URL
      const detectedFormat = FormatDetector.detectFromHeaders(
        contentType,
        details.url,
      );

      // Only process if we detected a known video format (not 'unknown')
      if (detectedFormat === "unknown") {
        return;
      }

      try {
        // Get tab information
        const tab = await chrome.tabs.get(details.tabId);
        if (!tab.url) {
          return;
        }

        // Send message to content script to handle video detection
        // The content script will use DetectionManager to process it
        chrome.tabs.sendMessage(
          details.tabId,
          {
            type: MessageType.VIDEO_DETECTED,
            payload: {
              url: details.url,
              format: detectedFormat,
              pageUrl: tab.url,
              title: tab.title,
            },
          },
          (response) => {
            // Ignore errors (content script might not be ready or might not handle this)
            if (chrome.runtime.lastError) {
              logger.debug(
                `Could not send video detection to tab ${details.tabId}:`,
                chrome.runtime.lastError.message,
              );
            }
          },
        );
      } catch (error) {
        logger.debug("Error in video detection:", error);
      }
    },
    {
      types: ["xmlhttprequest"],
       urls: ["http://*/*", "https://*/*"],
    },
    ["responseHeaders"],
  );

  logger.info("Video detection via webRequest initialized");
}

// Initialize service worker
init().catch((error) => {
  logger.error("Service worker initialization failed:", error);
});
