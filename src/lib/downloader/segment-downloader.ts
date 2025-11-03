/**
 * Downloads video segments with concurrent downloading and progress tracking
 */

import { SegmentInfo } from '../types';
import { NetworkError } from '../utils/errors';
import { logger } from '../utils/logger';

export interface DownloadProgress {
  downloaded: number;
  total: number;
  percentage: number;
  currentSegment?: number;
}

export interface SegmentDownloadOptions {
  maxConcurrent?: number;
  onProgress?: (progress: DownloadProgress) => void;
  retries?: number;
  retryDelay?: number;
}

export class SegmentDownloader {
  private maxConcurrent: number;
  private onProgress?: (progress: DownloadProgress) => void;
  private retries: number;
  private retryDelay: number;

  constructor(options: SegmentDownloadOptions = {}) {
    this.maxConcurrent = options.maxConcurrent || 3;
    this.onProgress = options.onProgress;
    this.retries = options.retries || 3;
    this.retryDelay = options.retryDelay || 1000;
  }

  /**
   * Download a single segment
   */
  async downloadSegment(segment: SegmentInfo): Promise<Blob> {
    let lastError: Error | null = null;
    
    for (let attempt = 0; attempt < this.retries; attempt++) {
      try {
        const response = await this.fetchSegment(segment);
        return response;
      } catch (error) {
        lastError = error as Error;
        logger.warn(`Segment download attempt ${attempt + 1} failed for ${segment.url}:`, error);
        
        if (attempt < this.retries - 1) {
          await this.delay(this.retryDelay * (attempt + 1)); // Exponential backoff
        }
      }
    }
    
    throw new NetworkError(
      `Failed to download segment after ${this.retries} attempts: ${lastError?.message}`,
      undefined
    );
  }

  /**
   * Fetch a single segment with byte range support
   */
  private async fetchSegment(segment: SegmentInfo): Promise<Blob> {
    const headers: HeadersInit = {};
    
    // Add Range header if byte range is specified
    if (segment.byteRange) {
      headers['Range'] = `bytes=${segment.byteRange.start}-${segment.byteRange.end}`;
    }
    
    const response = await fetch(segment.url, {
      method: 'GET',
      headers,
      mode: 'cors',
    });
    
    if (!response.ok) {
      throw new NetworkError(
        `Failed to download segment: ${response.statusText}`,
        response.status
      );
    }
    
    return await response.blob();
  }

  /**
   * Download all segments concurrently
   */
  async downloadAll(segments: SegmentInfo[]): Promise<Blob[]> {
    if (segments.length === 0) {
      return [];
    }

    const results: (Blob | null)[] = new Array(segments.length).fill(null);
    const downloadQueue = segments.map((seg, index) => ({ seg, index }));
    let activeDownloads = 0;
    let downloadedCount = 0;

    return new Promise((resolve, reject) => {
      const processQueue = async () => {
        while (downloadedCount < segments.length) {
          // Start new downloads if we have capacity
          while (activeDownloads < this.maxConcurrent && downloadQueue.length > 0) {
            const { seg, index } = downloadQueue.shift()!;
            activeDownloads++;

            this.downloadSegment(seg)
              .then(blob => {
                results[index] = blob;
                downloadedCount++;
                activeDownloads--;

                // Report progress
                if (this.onProgress) {
                  this.onProgress({
                    downloaded: downloadedCount,
                    total: segments.length,
                    percentage: (downloadedCount / segments.length) * 100,
                    currentSegment: index + 1,
                  });
                }

                processQueue();
              })
              .catch(error => {
                activeDownloads--;
                logger.error(`Failed to download segment ${index}:`, error);
                
                // Continue with other segments, mark as failed
                downloadedCount++;
                results[index] = null;
                
                if (this.onProgress) {
                  this.onProgress({
                    downloaded: downloadedCount,
                    total: segments.length,
                    percentage: (downloadedCount / segments.length) * 100,
                    currentSegment: index + 1,
                  });
                }
                
                processQueue();
              });
          }

          // Wait a bit before checking again
          if (downloadedCount < segments.length) {
            await this.delay(100);
          }
        }

        // Check if all downloads completed (some may have failed)
        const failed = results.filter(r => r === null).length;
        if (failed === segments.length) {
          reject(new NetworkError('All segment downloads failed'));
        } else {
          // Filter out null results (failed downloads)
          resolve(results.filter((r): r is Blob => r !== null));
        }
      };

      processQueue();
    });
  }

  /**
   * Download segments and store in IndexedDB (for large files)
   */
  async downloadToIndexedDB(
    segments: SegmentInfo[],
    dbName: string,
    storeName: string
  ): Promise<IDBValidKey[]> {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(dbName, 1);

      request.onerror = () => reject(new Error('Failed to open IndexedDB'));
      request.onsuccess = async () => {
        const db = request.result;

        // Create object store if it doesn't exist
        if (!db.objectStoreNames.contains(storeName)) {
          const upgradeReq = indexedDB.open(dbName, db.version + 1);
          upgradeReq.onupgradeneeded = () => {
            const upgradeDb = upgradeReq.result;
            upgradeDb.createObjectStore(storeName);
          };
          await new Promise((res, rej) => {
            upgradeReq.onsuccess = () => res(upgradeReq.result);
            upgradeReq.onerror = () => rej(upgradeReq.error);
          });
        }

        const store = db.transaction(storeName, 'readwrite').objectStore(storeName);
        const keys: IDBValidKey[] = [];

        try {
          const blobs = await this.downloadAll(segments);
          
          for (let i = 0; i < blobs.length; i++) {
            const key = `segment_${i}`;
            await new Promise<void>((res, rej) => {
              const putReq = store.put(blobs[i], key);
              putReq.onsuccess = () => {
                keys.push(key);
                res();
              };
              putReq.onerror = () => rej(putReq.error);
            });
          }

          resolve(keys);
        } catch (error) {
          reject(error);
        }
      };

      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(storeName)) {
          db.createObjectStore(storeName);
        }
      };
    });
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

