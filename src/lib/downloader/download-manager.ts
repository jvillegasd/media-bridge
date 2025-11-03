/**
 * Main download manager that orchestrates downloads
 */

import { VideoFormat, VideoMetadata, DownloadState } from '../types';
import { FormatDetector } from './format-detector';
import { HLSDownloader } from './hls-downloader';
import { DASHDownloader } from './dash-downloader';
import { DirectDownloader } from './direct-downloader';
import { SegmentMerger } from '../merger/segment-merger';
import { DownloadStateManager } from '../storage/download-state';
import { DownloadError } from '../utils/errors';
import { logger } from '../utils/logger';

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
  async download(url: string, filename?: string): Promise<DownloadState> {
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
      const format = await FormatDetector.detectWithInspection(url);
      
      state.metadata = {
        url,
        format,
      };
      state.progress.stage = 'downloading';
      state.progress.message = `Detected format: ${format}`;
      
      await DownloadStateManager.saveDownload(state);
      this.notifyProgress(state);

      // Download based on format
      let finalBlob: Blob;

      switch (format) {
        case 'hls':
          finalBlob = await this.downloadHLS(url);
          break;
        case 'dash':
          finalBlob = await this.downloadDASH(url);
          break;
        case 'direct':
          finalBlob = await this.downloadDirect(url);
          break;
        default:
          throw new DownloadError(`Unsupported format: ${format}`);
      }

      // Save file locally (using Chrome downloads API)
      const blobUrl = URL.createObjectURL(finalBlob);
      const downloadFilename = filename || this.generateFilename(url, format);
      
      state.progress.stage = 'saving';
      state.progress.message = 'Saving file...';
      await DownloadStateManager.saveDownload(state);
      this.notifyProgress(state);

      // Use Chrome downloads API to save file
      const downloadId = await new Promise<number>((resolve, reject) => {
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
      await this.waitForDownload(downloadId);

      // Get final download path
      const downloadItem = await new Promise<chrome.downloads.DownloadItem>((resolve, reject) => {
        chrome.downloads.search({ id: downloadId }, (results) => {
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

      URL.revokeObjectURL(blobUrl);

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
   * Download HLS stream
   */
  private async downloadHLS(url: string): Promise<Blob> {
    const hlsDownloader = new HLSDownloader({
      maxConcurrent: this.maxConcurrent,
      onProgress: (stage, progress) => {
        // Update progress via state manager
        logger.debug(`HLS download: ${stage}`, progress);
      },
    });

    const segments = await hlsDownloader.download(url);

    // Merge segments
    const merger = new SegmentMerger({
      onProgress: (progress) => {
        logger.debug('HLS merge progress:', progress);
      },
    });

    return await merger.mergeHLS(segments);
  }

  /**
   * Download DASH stream
   */
  private async downloadDASH(url: string): Promise<Blob> {
    const dashDownloader = new DASHDownloader({
      maxConcurrent: this.maxConcurrent,
      onProgress: (stage, stream, progress) => {
        logger.debug(`DASH download: ${stage} ${stream}`, progress);
      },
    });

    const dashResult = await dashDownloader.download(url);

    // Merge segments
    const merger = new SegmentMerger({
      onProgress: (progress) => {
        logger.debug('DASH merge progress:', progress);
      },
    });

    return await merger.mergeDASH(dashResult);
  }

  /**
   * Download direct video
   */
  private async downloadDirect(url: string): Promise<Blob> {
    const directDownloader = new DirectDownloader({
      onProgress: (loaded, total, percentage) => {
        logger.debug(`Direct download: ${percentage.toFixed(2)}%`);
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
   * Generate filename from URL
   */
  private generateFilename(url: string, format: VideoFormat): string {
    try {
      const urlObj = new URL(url);
      const pathname = urlObj.pathname;
      const filename = pathname.split('/').pop() || 'video';
      
      // Remove query parameters and extension, add appropriate extension
      const baseName = filename.split('?')[0].split('.')[0];
      const extension = format === 'hls' || format === 'dash' ? 'mp4' : filename.split('.').pop() || 'mp4';
      
      return `${baseName}.${extension}`;
    } catch {
      return `video_${Date.now()}.mp4`;
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

