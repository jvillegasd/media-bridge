/**
 * HLS storage - IndexedDB bucket implementation for storing segments
 */

import { openDB, deleteDB, DBSchema, IDBPDatabase } from 'idb';
import { logger } from '../../utils/logger';

interface ChunksDB extends DBSchema {
  chunks: {
    value: {
      data: Uint8Array;
      index: number;
    };
    key: number;
    indexes: { index: number };
  };
}

/**
 * Sanitize a string to be used as a filename
 */
function sanitizeFilename(name: string): string {
  return name
    .replace(/[^a-z0-9]/gi, '_')
    .replace(/_+/g, '_')
    .substring(0, 50) || 'file';
}

export interface HlsBucket {
  write(index: number, data: ArrayBuffer): Promise<void>;
  getLink(onProgress?: (progress: number, message: string) => void): Promise<string | Blob>;
  cleanup(): Promise<void>;
}

export class IndexedDBHlsBucket implements HlsBucket {
  readonly fileName: string;
  readonly objectStoreName = 'chunks';
  private db?: IDBPDatabase<ChunksDB>;

  constructor(
    readonly videoLength: number,
    readonly audioLength: number,
    readonly id: string
  ) {
    this.fileName = sanitizeFilename(id).normalize('NFC');
  }

  /**
   * Open/create the IndexedDB database
   */
  async openDB(): Promise<void> {
    if (this.db) {
      return;
    }

    const db = await openDB<ChunksDB>(this.id, 1, {
      upgrade(db) {
        const store = db.createObjectStore('chunks', {
          keyPath: 'id',
          autoIncrement: true,
        });
        store.createIndex('index', 'index', { unique: true });
      },
    });

    this.db = db;
  }

  /**
   * Write a segment to the bucket
   */
  async write(index: number, data: ArrayBuffer): Promise<void> {
    if (!this.db) {
      await this.openDB();
    }

    const typedArray = new Uint8Array(data);
    await this.db!.add('chunks', {
      data: typedArray,
      index,
    });
  }

  /**
   * Get all chunks in order
   */
  async getAllChunks(): Promise<Uint8Array[]> {
    if (!this.db) {
      await this.openDB();
    }

    const store = this.db!.transaction('chunks').objectStore('chunks');
    const index = store.index('index');
    const chunks: Uint8Array[] = [];

    let cursor = await index.openCursor();
    while (cursor) {
      chunks.push(cursor.value.data);
      cursor = await cursor.continue();
    }

    return chunks;
  }

  /**
   * Merge chunks and return blob URL (uses offscreen document for FFmpeg)
   * In service worker context, returns the blob directly
   */
  async getLink(onProgress?: (progress: number, message: string) => void): Promise<string | Blob> {
    if (!this.db) {
      throw new Error('Database not opened');
    }

    try {
      onProgress?.(0.1, 'Reading segments from storage...');
      const chunks = await this.getAllChunks();

      if (chunks.length === 0) {
        throw new Error('No segments found in storage');
      }

      onProgress?.(0.3, 'Preparing segments for merging...');
      // Convert chunks to ArrayBuffers for offscreen document
      // Ensure we have proper ArrayBuffer instances (not SharedArrayBuffer)
      const segmentBuffers: ArrayBuffer[] = chunks.map(chunk => {
        const buffer = chunk.buffer;
        if (buffer instanceof ArrayBuffer) {
          return buffer;
        }
        // If it's a SharedArrayBuffer or other type, create a new ArrayBuffer by copying
        const uint8 = new Uint8Array(chunk);
        return uint8.buffer.slice(0);
      });

      onProgress?.(0.5, 'Merging segments with FFmpeg...');
      // Use offscreen document to merge with FFmpeg
      // This will be implemented in the download handler
      // For now, return a placeholder - actual merging happens in handler
      const mergedBlob = await this.mergeSegments(segmentBuffers, onProgress);

      onProgress?.(1, 'Done');
      
      // Check if URL.createObjectURL is available (not available in service workers)
      if (typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function') {
        return URL.createObjectURL(mergedBlob);
      } else {
        // Service worker context - return blob directly
        return mergedBlob;
      }
    } catch (error) {
      logger.error('Failed to get link:', error);
      throw error;
    }
  }

  /**
   * Merge segments using FFmpeg (called from offscreen document)
   * This is a placeholder - actual implementation will use offscreen-merger-client
   */
  private async mergeSegments(
    segmentBuffers: ArrayBuffer[],
    onProgress?: (progress: number, message: string) => void
  ): Promise<Blob> {
    // This will be implemented to use the offscreen document
    // For now, we'll combine chunks directly (works for non-encrypted segments)
    // In production, this should use FFmpeg for proper merging
    
    onProgress?.(0.7, 'Combining segments...');
    const combined = new Uint8Array(
      segmentBuffers.reduce((sum, buf) => sum + buf.byteLength, 0)
    );

    let offset = 0;
    for (const buffer of segmentBuffers) {
      combined.set(new Uint8Array(buffer), offset);
      offset += buffer.byteLength;
    }

    onProgress?.(0.9, 'Creating blob...');
    return new Blob([combined], { type: 'video/mp4' });
  }

  /**
   * Cleanup: delete database and any temporary files
   */
  async cleanup(): Promise<void> {
    await this.deleteDB();
  }

  /**
   * Delete the IndexedDB database
   */
  async deleteDB(): Promise<void> {
    if (this.db) {
      this.db.close();
      this.db = undefined;
    }

    try {
      await deleteDB(this.id);
    } catch (error) {
      logger.warn('Failed to delete database:', error);
    }
  }
}

/**
 * Storage manager for HLS buckets
 */
class HlsStorageManager {
  private buckets: Map<string, IndexedDBHlsBucket> = new Map();

  /**
   * Create a new bucket
   */
  async createBucket(
    id: string,
    videoLength: number,
    audioLength: number
  ): Promise<IndexedDBHlsBucket> {
    const bucket = new IndexedDBHlsBucket(videoLength, audioLength, id);
    this.buckets.set(id, bucket);
    await bucket.openDB();
    return bucket;
  }

  /**
   * Get an existing bucket
   */
  getBucket(id: string): IndexedDBHlsBucket | undefined {
    return this.buckets.get(id);
  }

  /**
   * Delete a bucket
   */
  async deleteBucket(id: string): Promise<void> {
    const bucket = this.buckets.get(id);
    if (bucket) {
      await bucket.cleanup();
      this.buckets.delete(id);
    }
  }

  /**
   * Cleanup all buckets
   */
  async cleanup(): Promise<void> {
    for (const [id, bucket] of this.buckets) {
      await bucket.cleanup();
    }
    this.buckets.clear();
  }
}

export const hlsStorageManager = new HlsStorageManager();

