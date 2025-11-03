/**
 * Background service worker for download orchestration
 */

import { DownloadManager } from '../lib/downloader/download-manager';
import { DownloadStateManager } from '../lib/storage/download-state';
import { UploadManager } from '../lib/cloud/upload-manager';
import { ChromeStorage } from '../lib/storage/chrome-storage';
import { MessageType } from '../shared/messages';
import { DownloadState, StorageConfig } from '../lib/types';
import { logger } from '../lib/utils/logger';

// Configuration keys
const CONFIG_KEY = 'storage_config';
const MAX_CONCURRENT_KEY = 'max_concurrent';

// Active downloads
const activeDownloads = new Map<string, Promise<void>>();

/**
 * Initialize service worker
 */
async function init() {
  logger.info('Service worker initialized');
  
  // Handle messages
  chrome.runtime.onMessage.addListener(handleMessage);
  
  // Handle extension installation
  chrome.runtime.onInstalled.addListener(handleInstallation);
}

/**
 * Handle extension installation
 */
function handleInstallation(details: chrome.runtime.InstalledDetails) {
  if (details.reason === 'install') {
    logger.info('Extension installed');
    // Open options page on first install
    chrome.runtime.openOptionsPage();
  }
}

/**
 * Handle messages from popup and content scripts
 */
async function handleMessage(
  message: any,
  sender: chrome.runtime.MessageSender,
  sendResponse: (response: any) => void
): Promise<boolean> {
  try {
    switch (message.type) {
      case MessageType.DOWNLOAD_REQUEST:
        await handleDownloadRequest(message.payload);
        sendResponse({ success: true });
        return true;

      case MessageType.GET_DOWNLOADS:
        const downloads = await DownloadStateManager.getAllDownloads();
        sendResponse({ success: true, data: downloads });
        return true;

      case MessageType.CANCEL_DOWNLOAD:
        await handleCancelDownload(message.payload.id);
        sendResponse({ success: true });
        return true;

      case MessageType.GET_CONFIG:
        const config = await ChromeStorage.get<StorageConfig>(CONFIG_KEY);
        sendResponse({ success: true, data: config });
        return true;

      case MessageType.SAVE_CONFIG:
        await ChromeStorage.set(CONFIG_KEY, message.payload);
        sendResponse({ success: true });
        return true;

      default:
        logger.warn(`Unknown message type: ${message.type}`);
        sendResponse({ success: false, error: 'Unknown message type' });
        return false;
    }
  } catch (error) {
    logger.error('Message handling error:', error);
    sendResponse({ 
      success: false, 
      error: error instanceof Error ? error.message : String(error) 
    });
    return false;
  }
}

/**
 * Handle download request
 */
async function handleDownloadRequest(payload: {
  url: string;
  filename?: string;
  uploadToDrive?: boolean;
}) {
  const { url, filename, uploadToDrive } = payload;
  
  // Check if download already exists
  const existing = await DownloadStateManager.getDownloadByUrl(url);
  if (existing && existing.progress.stage === 'completed') {
    logger.info(`Download already exists for ${url}`);
    return;
  }

  // Get configuration
  const config = await ChromeStorage.get<StorageConfig>(CONFIG_KEY);
  const maxConcurrent = await ChromeStorage.get<number>(MAX_CONCURRENT_KEY) || 3;

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
  
  // Start download
  const downloadPromise = startDownload(downloadManager, undefined, url, filename);
  activeDownloads.set(url, downloadPromise);

  // Clean up when done
  downloadPromise
    .then(() => {
      activeDownloads.delete(url);
    })
    .catch((error) => {
      logger.error(`Download failed for ${url}:`, error);
      activeDownloads.delete(url);
    });
}

/**
 * Start download process
 */
async function startDownload(
  downloadManager: DownloadManager,
  uploadManager: UploadManager | undefined,
  url: string,
  filename?: string
): Promise<void> {
  try {
    // Download video
    const downloadState = await downloadManager.download(url, filename);

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

  // Remove from active downloads
  activeDownloads.delete(download.url);

  // Update state
  download.progress.stage = 'failed';
  download.progress.error = 'Cancelled by user';
  await DownloadStateManager.saveDownload(download);
  
  logger.info(`Download cancelled: ${id}`);
}

// Initialize service worker
init().catch(error => {
  logger.error('Service worker initialization failed:', error);
});

