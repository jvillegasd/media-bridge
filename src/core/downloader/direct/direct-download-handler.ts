/**
 * Direct download handler - orchestrates direct video downloads
 */

import { DirectDownloader } from './direct-downloader';
import { DownloadStateManager } from '../../storage/download-state';
import { DownloadState } from '../../types';
import { logger } from '../../utils/logger';

export interface DirectDownloadHandlerOptions {
  onProgress?: (state: DownloadState) => void;
}

export class DirectDownloadHandler {
  private onProgress?: (state: DownloadState) => void;

  constructor(options: DirectDownloadHandlerOptions = {}) {
    this.onProgress = options.onProgress;
  }

  /**
   * Download direct video and return blob
   */
  async download(url: string, stateId: string): Promise<Blob> {
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

    return await directDownloader.download(url);
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

