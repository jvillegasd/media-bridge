/**
 * Direct video URL downloader
 */

import { DownloadError, NetworkError } from '../../utils/errors';
import { logger } from '../../utils/logger';
import { DirectDownloadProgressCallback } from '../types';

export interface DirectDownloadOptions {
  onProgress?: DirectDownloadProgressCallback;
}

export class DirectDownloader {
  private readonly onProgress?: DirectDownloadProgressCallback;

  constructor(options: DirectDownloadOptions = {}) {
    this.onProgress = options.onProgress;
  }

  /**
   * Download video from direct URL
   */
  async download(url: string): Promise<Blob> {
    try {
      logger.info(`Downloading direct video from ${url}`);

      const response = await fetch(url, {
        method: 'GET',
        mode: 'cors',
      });

      if (!response.ok) {
        throw new NetworkError(
          `Failed to download video: ${response.statusText}`,
          response.status
        );
      }

      const contentLength = response.headers.get('content-length');
      const total = contentLength ? parseInt(contentLength, 10) : 0;

      if (!response.body) {
        throw new DownloadError('Response body is null');
      }

      const reader = response.body.getReader();
      const chunks: BlobPart[] = [];
      let loaded = 0;
      const startTime = Date.now();

      while (true) {
        const { done, value } = await reader.read();

        if (done) {
          break;
        }

        chunks.push(value);
        loaded += value.length;

        // Report progress even if total is unknown (estimate based on loaded bytes)
        if (this.onProgress) {
          if (total > 0) {
            const percentage = (loaded / total) * 100;
            this.onProgress(loaded, total, percentage);
          } else {
            // If total is unknown, still report progress with estimated percentage
            // Show as indeterminate or use a placeholder
            this.onProgress(loaded, 0, 0);
          }
        }
      }

      // Combine chunks into single blob
      const blob = new Blob(chunks, { type: response.headers.get('content-type') || 'video/mp4' });

      logger.info(`Successfully downloaded ${loaded} bytes`);
      
      return blob;
    } catch (error) {
      logger.error('Direct download failed:', error);
      throw error instanceof DownloadError || error instanceof NetworkError
        ? error
        : new DownloadError(`Direct download failed: ${error}`);
    }
  }

  /**
   * Download with resume support (if server supports Range requests)
   */
  async downloadWithResume(url: string, existingBlob?: Blob): Promise<Blob> {
    const existingSize = existingBlob?.size || 0;
    
    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: existingSize > 0 ? {
          Range: `bytes=${existingSize}-`,
        } : {},
        mode: 'cors',
      });

      if (!response.ok && response.status !== 206) {
        throw new NetworkError(
          `Failed to resume download: ${response.statusText}`,
          response.status
        );
      }

      const contentLength = response.headers.get('content-length');
      const contentRange = response.headers.get('content-range');
      
      let total = existingSize;
      if (contentLength) {
        total = existingSize + parseInt(contentLength, 10);
      } else if (contentRange) {
        const match = contentRange.match(/bytes \d+-\d+\/(\d+)/);
        if (match) {
          total = parseInt(match[1], 10);
        }
      }

      if (!response.body) {
        throw new DownloadError('Response body is null');
      }

      const reader = response.body.getReader();
      const chunks: BlobPart[] = existingBlob ? [new Uint8Array(await existingBlob.arrayBuffer())] : [];
      let loaded = existingSize;

      while (true) {
        const { done, value } = await reader.read();

        if (done) {
          break;
        }

        chunks.push(value);
        loaded += value.length;

        if (this.onProgress && total > 0) {
          const percentage = (loaded / total) * 100;
          this.onProgress(loaded, total, percentage);
        }
      }

      const blob = new Blob(chunks, { type: response.headers.get('content-type') || 'video/mp4' });
      return blob;
    } catch (error) {
      logger.error('Resume download failed:', error);
      throw error instanceof DownloadError || error instanceof NetworkError
        ? error
        : new DownloadError(`Resume download failed: ${error}`);
    }
  }
}

