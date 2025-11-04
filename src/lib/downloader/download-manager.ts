/**
 * Main download manager that orchestrates downloads
 */

import { VideoFormat, VideoMetadata, DownloadState } from '../types';
import { FormatDetector } from './format-detector';
import { DirectDownloader } from './direct-downloader';
import { DownloadStateManager } from '../storage/download-state';
import { DownloadError } from '../utils/errors';
import { logger } from '../utils/logger';
import {
  extractMetadataFromDirectBlob,
} from '../merger/metadata-extractor';

export interface DownloadManagerOptions {
  maxConcurrent?: number;
  onProgress?: (state: DownloadState) => void;
  uploadToDrive?: boolean;
}

export class DownloadManager {
  private maxConcurrent: number;
  private onProgress?: (state: DownloadState) => void;
  private uploadToDrive: boolean;

  constructor(options: DownloadManagerOptions = {}) {
    this.maxConcurrent = options.maxConcurrent || 3;
    this.onProgress = options.onProgress;
    this.uploadToDrive = options.uploadToDrive || false;
  }

  /**
   * Download video from URL
   */
  async download(url: string, filename?: string, metadata?: VideoMetadata): Promise<DownloadState> {
    const downloadId = this.generateDownloadId(url);
    
    try {
      // Create initial download state
      let state: DownloadState = {
        id: downloadId,
        url,
        progress: {
          url,
          stage: 'detecting',
          percentage: 0,
        },
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      await DownloadStateManager.saveDownload(state);
      this.notifyProgress(state);

      // Detect format
      logger.info(`Detecting format for ${url}`);
      // detectWithInspection always returns a valid VideoFormat (never 'unknown')
      // It defaults to 'direct' if format can't be determined
      let format: VideoFormat = await FormatDetector.detectWithInspection(url);
      
      // If we got 'unknown' from URL detection (shouldn't happen with detectWithInspection, but handle it)
      // Try URL-based detection as additional fallback
      const urlBasedFormat = FormatDetector.detectFromUrl(url);
      if (urlBasedFormat !== 'unknown') {
        format = urlBasedFormat;
      }
      
      logger.info(`Detected format: ${format} for URL: ${url}`);
      
      // Use provided metadata if available, otherwise create minimal metadata
      if (metadata) {
        // Merge provided metadata with detected format
        state.metadata = {
          ...metadata,
          format,
        };
      } else {
        // Create minimal metadata from URL
        state.metadata = {
          url,
          format,
        };
      }
      state.progress.stage = 'downloading';
      state.progress.message = `Detected format: ${format}`;
      
      await DownloadStateManager.saveDownload(state);
      this.notifyProgress(state);

      // Check if URL is a page URL - if so, try to extract actual video URL from metadata
      const isPageUrl = this.isPageUrl(url);
      let actualVideoUrl = url;
      
      if (isPageUrl && format === 'direct' && metadata) {
        // Try to find actual video URL from metadata or video element
        // For now, log a warning - in the future we could request content script to extract it
        logger.warn(`URL appears to be a page URL: ${url}`);
        
        // If metadata has a real video URL stored separately, use it
        // This would require content script to extract and store it
        if (metadata.url && !this.isPageUrl(metadata.url) && metadata.url !== url) {
          actualVideoUrl = metadata.url;
          logger.info(`Using actual video URL from metadata: ${actualVideoUrl}`);
        } else {
          throw new Error('Cannot download page URLs directly. The video URL appears to be a page URL, not a direct video file. Please ensure the actual video file URL is detected.');
        }
      }

      // Download video (only direct downloads supported)
      let finalBlob: Blob;
      let extractedMetadata: Partial<VideoMetadata> = {};

      // Always download as direct video
      finalBlob = await this.downloadDirect(actualVideoUrl, state.id);
      // Extract metadata from direct video blob
      const contentType = finalBlob.type;
      const directMetadata = await extractMetadataFromDirectBlob(finalBlob, actualVideoUrl, contentType);
      extractedMetadata.fileExtension = directMetadata.extension;

      // Update state metadata with extracted information
      if (state.metadata) {
        state.metadata = {
          ...state.metadata,
          ...extractedMetadata,
        };
      } else {
        state.metadata = {
          url: actualVideoUrl,
          format,
          ...extractedMetadata,
        };
      }

      // Save updated metadata
      state.updatedAt = Date.now();
      await DownloadStateManager.saveDownload(state);

      // Save file locally (using Chrome downloads API)
      // Use detected extension if available, otherwise use mp4
      const detectedExtension = extractedMetadata.fileExtension || 'mp4';
      const downloadFilename = filename || this.generateFilenameWithExtension(url, format, detectedExtension);
      
      state.progress.stage = 'saving';
      state.progress.message = 'Saving file...';
      await DownloadStateManager.saveDownload(state);
      this.notifyProgress(state);

      // Create blob URL with fallback for service worker contexts
      let blobUrl: string;
      try {
        // Check if URL.createObjectURL is available
        if (typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function') {
          blobUrl = URL.createObjectURL(finalBlob);
          logger.debug('Created blob URL using URL.createObjectURL');
        } else {
          // Fallback: convert to data URL (for small files only)
          // Note: This has size limitations, but works when URL.createObjectURL isn't available
          const MAX_DATA_URL_SIZE = 100 * 1024 * 1024; // 100MB limit for data URLs
          if (finalBlob.size > MAX_DATA_URL_SIZE) {
            throw new Error(
              `File too large (${(finalBlob.size / 1024 / 1024).toFixed(2)}MB) for data URL conversion. ` +
              `URL.createObjectURL is not available in this context.`
            );
          }
          
          // Convert blob to base64 using chunked approach for large files
          const arrayBuffer = await finalBlob.arrayBuffer();
          const uint8Array = new Uint8Array(arrayBuffer);
          
          // Convert in chunks to avoid stack overflow
          let binaryString = '';
          const chunkSize = 8192; // Process 8KB at a time
          for (let i = 0; i < uint8Array.length; i += chunkSize) {
            const chunk = uint8Array.slice(i, i + chunkSize);
            binaryString += String.fromCharCode.apply(null, Array.from(chunk));
          }
          
          const base64 = btoa(binaryString);
          const mimeType = finalBlob.type || 'video/mp4';
          blobUrl = `data:${mimeType};base64,${base64}`;
          logger.warn('Using data URL fallback for blob saving (URL.createObjectURL not available)');
        }
      } catch (error) {
        logger.error('Failed to create blob URL:', error);
        const errorMessage = error instanceof Error ? error.message : String(error);
        throw new Error(`Failed to create blob URL for download: ${errorMessage}`);
      }

      // Use Chrome downloads API to save file
      const chromeDownloadId = await new Promise<number>((resolve, reject) => {
        chrome.downloads.download({
          url: blobUrl,
          filename: downloadFilename,
          saveAs: false,
        }, (id) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
          } else {
            resolve(id!);
          }
        });
      });

      // Wait for download to complete
      await this.waitForDownload(chromeDownloadId);

      // Get final download path
      const downloadItem = await new Promise<chrome.downloads.DownloadItem>((resolve, reject) => {
        chrome.downloads.search({ id: chromeDownloadId }, (results) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
          } else if (results && results[0]) {
            resolve(results[0]);
          } else {
            reject(new Error('Download not found'));
          }
        });
      });

      state.localPath = downloadItem.filename;
      state.progress.stage = 'completed';
      state.progress.percentage = 100;
      state.progress.message = 'Download completed';

      await DownloadStateManager.saveDownload(state);
      this.notifyProgress(state);

      // Note: Google Drive upload would need to be handled separately
      // as we can't easily read the downloaded file back
      // The blob is available in finalBlob, but it's already saved
      // A better approach would be to upload first, then save, or store blob for upload

      // Revoke blob URL if it was created with URL.createObjectURL
      try {
        if (typeof URL !== 'undefined' && URL.revokeObjectURL && blobUrl.startsWith('blob:')) {
          URL.revokeObjectURL(blobUrl);
        }
      } catch (error) {
        // Ignore errors when revoking
        logger.debug('Error revoking blob URL:', error);
      }

      return state;
    } catch (error) {
      logger.error('Download failed:', error);
      
      const failedState: DownloadState = {
        id: downloadId,
        url,
        progress: {
          url,
          stage: 'failed',
          error: error instanceof Error ? error.message : String(error),
        },
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      await DownloadStateManager.saveDownload(failedState);
      this.notifyProgress(failedState);

      throw error;
    }
  }

  /**
   * Download direct video
   */
  private async downloadDirect(url: string, stateId: string): Promise<Blob> {
    const directDownloader = new DirectDownloader({
      onProgress: async (loaded, total, percentage) => {
        logger.debug(`Direct download: ${percentage.toFixed(2)}%`);
        
        // Get current download state by ID to update progress
        const currentState = await DownloadStateManager.getDownload(stateId);
        if (currentState) {
          currentState.progress.downloaded = loaded;
          currentState.progress.total = total;
          currentState.progress.percentage = percentage;
          currentState.progress.stage = 'downloading';
          
          // Calculate speed (bytes per second) - use a rolling window
          const now = Date.now();
          if (currentState.progress.lastUpdateTime && currentState.progress.lastDownloaded !== undefined) {
            const elapsed = (now - currentState.progress.lastUpdateTime) / 1000;
            if (elapsed > 0.5) { // Only update speed every 0.5 seconds to avoid too frequent updates
              const bytesDelta = loaded - currentState.progress.lastDownloaded;
              if (bytesDelta > 0) {
                currentState.progress.speed = bytesDelta / elapsed;
                currentState.progress.lastUpdateTime = now;
                currentState.progress.lastDownloaded = loaded;
              }
            }
          } else {
            // First update - initialize tracking
            currentState.progress.lastUpdateTime = now;
            currentState.progress.lastDownloaded = loaded;
            currentState.progress.speed = 0;
          }
          
          await DownloadStateManager.saveDownload(currentState);
          this.notifyProgress(currentState);
        }
      },
    });

    return await directDownloader.download(url);
  }

  /**
   * Wait for Chrome download to complete
   */
  private waitForDownload(downloadId: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const checkDownload = () => {
        chrome.downloads.search({ id: downloadId }, (results) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
            return;
          }

          if (!results || results.length === 0) {
            reject(new Error('Download not found'));
            return;
          }

          const item = results[0];
          if (item.state === 'complete') {
            resolve();
          } else if (item.state === 'interrupted') {
            reject(new Error(`Download interrupted: ${item.error}`));
          } else {
            setTimeout(checkDownload, 500);
          }
        });
      };

      checkDownload();
    });
  }

  /**
   * Generate download ID
   */
  private generateDownloadId(url: string): string {
    return `dl_${Date.now()}_${url.substring(0, 20).replace(/[^a-z0-9]/gi, '')}`;
  }

  /**
   * Generate filename from URL with specific extension
   */
  private generateFilenameWithExtension(url: string, format: VideoFormat, extension: string): string {
    try {
      const urlObj = new URL(url);
      const pathname = urlObj.pathname;
      const filename = pathname.split('/').pop() || 'video';
      
      // Remove query parameters and existing extension
      const baseName = filename.split('?')[0].split('.')[0];
      
      return `${baseName}.${extension}`;
    } catch {
      // Fallback if URL parsing fails
      const timestamp = Date.now();
      return `video_${timestamp}.${extension}`;
    }
  }


  /**
   * Check if URL is a page URL (like view_video.php) vs actual video file
   */
  private isPageUrl(url: string): boolean {
    try {
      const urlObj = new URL(url);
      const pathname = urlObj.pathname.toLowerCase();
      const hostname = urlObj.hostname.toLowerCase();
      
      // Check for common page URL patterns
      const pagePatterns = [
        /view_video/i,
        /watch/i,
        /video\.php/i,
        /embed/i,
        /\.html$/i,
        /\.php$/i,
      ];
      
      // Check pathname
      if (pagePatterns.some(pattern => pattern.test(pathname))) {
        return true;
      }
      
      // Check for hash fragments that indicate page anchors (not video files)
      if (urlObj.hash && urlObj.hash.includes('video-')) {
        return true;
      }
      
      // Check if it's a known video site page URL
      if (hostname.includes('pornhub.com') && pathname.includes('/view_video')) {
        return true;
      }
      
      if ((hostname.includes('youtube.com') || hostname.includes('youtu.be')) && pathname.includes('/watch')) {
        return true;
      }
      
      return false;
    } catch {
      // If URL parsing fails, assume it's not a page URL
      return false;
    }
  }

  /**
   * Notify progress
   */
  private notifyProgress(state: DownloadState): void {
    if (this.onProgress) {
      this.onProgress(state);
    }
  }
}

