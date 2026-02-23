/**
 * Chunks model for IndexedDB
 * Stores HLS video chunks in order so they can be concatenated later
 */

import { logger } from "../utils/logger";
import { openDatabase, CHUNKS_STORE_NAME } from "./connection";

interface ChunkRecord {
  downloadId: string;
  index: number;
  data: ArrayBuffer;
}

/**
 * Store a chunk in IndexedDB
 */
export async function storeChunk(
  downloadId: string,
  index: number,
  data: ArrayBuffer,
): Promise<void> {
  try {
    const db = await openDatabase();
    const transaction = db.transaction([CHUNKS_STORE_NAME], "readwrite");
    const store = transaction.objectStore(CHUNKS_STORE_NAME);

    const record: ChunkRecord = {
      downloadId,
      index,
      data,
    };

    await new Promise<void>((resolve, reject) => {
      const request = store.put(record);
      request.onsuccess = () => resolve();
      request.onerror = () =>
        reject(new Error(`Failed to store chunk: ${request.error}`));
    });

    // Connection is reused via caching, no close needed
  } catch (error) {
    logger.error(
      `Failed to store chunk ${index} for download ${downloadId}:`,
      error,
    );
    throw error;
  }
}

/**
 * Get all chunks for a download in order
 */
export async function getAllChunks(downloadId: string): Promise<ArrayBuffer[]> {
  try {
    const db = await openDatabase();
    const transaction = db.transaction([CHUNKS_STORE_NAME], "readonly");
    const store = transaction.objectStore(CHUNKS_STORE_NAME);
    const index = store.index("downloadId");

    const chunks = await new Promise<ChunkRecord[]>((resolve, reject) => {
      const request = index.getAll(downloadId);
      request.onsuccess = () => {
        // Records from the downloadId index come pre-sorted by composite key [downloadId, index]
        resolve(request.result as ChunkRecord[]);
      };
      request.onerror = () =>
        reject(new Error(`Failed to get chunks: ${request.error}`));
    });

    // Connection is reused via caching, no close needed

    return chunks.map((chunk) => chunk.data);
  } catch (error) {
    logger.error(`Failed to get chunks for download ${downloadId}:`, error);
    throw error;
  }
}

/**
 * Delete all chunks for a download
 */
export async function deleteChunks(downloadId: string): Promise<void> {
  try {
    const db = await openDatabase();
    const transaction = db.transaction([CHUNKS_STORE_NAME], "readwrite");
    const store = transaction.objectStore(CHUNKS_STORE_NAME);
    const index = store.index("downloadId");

    await new Promise<void>((resolve, reject) => {
      const cursorRequest = index.openCursor(downloadId);

      cursorRequest.onsuccess = () => {
        const cursor = cursorRequest.result;
        if (cursor) {
          cursor.delete();
          cursor.continue();
        } else {
          resolve();
        }
      };

      cursorRequest.onerror = () => {
        reject(new Error(`Failed to delete chunks: ${cursorRequest.error}`));
      };

      transaction.onerror = () => {
        reject(new Error(`Chunk deletion transaction failed: ${transaction.error}`));
      };
    });

    // Connection is reused via caching, no close needed
  } catch (error) {
    logger.error(`Failed to delete chunks for download ${downloadId}:`, error);
    throw error;
  }
}

/**
 * Get the count of chunks for a download
 */
export async function getChunkCount(downloadId: string): Promise<number> {
  try {
    const db = await openDatabase();
    const transaction = db.transaction([CHUNKS_STORE_NAME], "readonly");
    const store = transaction.objectStore(CHUNKS_STORE_NAME);
    const index = store.index("downloadId");

    const count = await new Promise<number>((resolve, reject) => {
      const request = index.count(downloadId);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () =>
        reject(new Error(`Failed to count chunks: ${request.error}`));
    });

    // Connection is reused via caching, no close needed
    return count;
  } catch (error) {
    logger.error(`Failed to count chunks for download ${downloadId}:`, error);
    throw error;
  }
}

/**
 * Read a single chunk by index
 */
export async function readChunkByIndex(
  downloadId: string,
  index: number,
): Promise<Uint8Array | null> {
  try {
    const db = await openDatabase();
    const transaction = db.transaction([CHUNKS_STORE_NAME], "readonly");
    const store = transaction.objectStore(CHUNKS_STORE_NAME);

    const record = await new Promise<ChunkRecord | undefined>(
      (resolve, reject) => {
        const request = store.get([downloadId, index]);
        request.onsuccess = () =>
          resolve(request.result as ChunkRecord | undefined);
        request.onerror = () =>
          reject(new Error(`Failed to read chunk: ${request.error}`));
      },
    );

    // Connection is reused via caching, no close needed

    if (!record) {
      return null;
    }

    return new Uint8Array(record.data);
  } catch (error) {
    logger.error(
      `Failed to read chunk ${index} for download ${downloadId}:`,
      error,
    );
    throw error;
  }
}

