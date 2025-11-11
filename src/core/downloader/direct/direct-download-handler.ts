/**
 * Direct download handler - orchestrates direct video downloads
 */

import { DirectDownloader } from './direct-downloader';
import { DownloadStateManager } from '../../storage/download-state';
import { DownloadState, VideoFormat } from '../../types';
import { logger } from '../../utils/logger';
import { extractMetadataFromDirectBlob } from '../../metadata/metadata-extractor';
import { DownloadProgressCallback, DownloadResult } from '../types';

export interface DirectDownloadHandlerOptions {
  onProgress?: DownloadProgressCallback;
}

export class DirectDownloadHandler {
  private readonly onProgress?: DownloadProgressCallback;

  constructor(options: DirectDownloadHandlerOptions = {}) {
    this.onProgress = options.onProgress;
  }

  /**
   * Download direct video and return blob with extracted metadata
   */
  async download(url: string, stateId: string): Promise<DownloadResult> {
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
          if (
            currentState.progress.lastUpdateTime &&
            currentState.progress.lastDownloaded !== undefined
          ) {
            const elapsed = (now - currentState.progress.lastUpdateTime) / 1000;
            if (elapsed > 0.5) {
              // Only update speed every 0.5 seconds to avoid too frequent updates
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

    const blob = await directDownloader.download(url);
    
    // Extract metadata from direct video blob
    const contentType = blob.type;
    const directMetadata = await extractMetadataFromDirectBlob(blob, url, contentType);
    
    // Update state with extracted metadata
    const currentState = await DownloadStateManager.getDownload(stateId);
    if (currentState) {
      currentState.metadata = {
        ...currentState.metadata,
        fileExtension: directMetadata.extension,
      };
      currentState.updatedAt = Date.now();
      await DownloadStateManager.saveDownload(currentState);
    }
    
    return {
      blob,
      extractedMetadata: {
        fileExtension: directMetadata.extension,
      },
    };
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

