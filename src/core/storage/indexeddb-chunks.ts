/**
 * IndexedDB utility for storing HLS video chunks
 * Stores chunks in order so they can be concatenated later
 */

import { logger } from "../utils/logger";

const DB_NAME = "media-bridge-chunks";
const DB_VERSION = 1;
const STORE_NAME = "chunks";

interface ChunkRecord {
  downloadId: string;
  index: number;
  data: ArrayBuffer;
}

/**
 * Open IndexedDB database
 */
function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onerror = () => {
      reject(new Error(`Failed to open IndexedDB: ${request.error}`));
    };

    request.onsuccess = () => {
      resolve(request.result);
    };

    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, {
          keyPath: ["downloadId", "index"],
        });
        store.createIndex("downloadId", "downloadId", { unique: false });
        store.createIndex("index", "index", { unique: false });
      }
    };
  });
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
    const transaction = db.transaction([STORE_NAME], "readwrite");
    const store = transaction.objectStore(STORE_NAME);

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

    db.close();
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
    const transaction = db.transaction([STORE_NAME], "readonly");
    const store = transaction.objectStore(STORE_NAME);
    const index = store.index("downloadId");

    const chunks = await new Promise<ChunkRecord[]>((resolve, reject) => {
      const request = index.getAll(downloadId);
      request.onsuccess = () => {
        const records = request.result as ChunkRecord[];
        // Sort by index to ensure correct order
        records.sort((a, b) => a.index - b.index);
        resolve(records);
      };
      request.onerror = () =>
        reject(new Error(`Failed to get chunks: ${request.error}`));
    });

    db.close();

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
    const transaction = db.transaction([STORE_NAME], "readwrite");
    const store = transaction.objectStore(STORE_NAME);
    const index = store.index("downloadId");

    const chunks = await new Promise<ChunkRecord[]>((resolve, reject) => {
      const request = index.getAll(downloadId);
      request.onsuccess = () => resolve(request.result as ChunkRecord[]);
      request.onerror = () =>
        reject(new Error(`Failed to get chunks: ${request.error}`));
    });

    await new Promise<void>((resolve, reject) => {
      let completed = 0;
      const total = chunks.length;

      if (total === 0) {
        resolve();
        return;
      }

      chunks.forEach((chunk) => {
        const deleteRequest = store.delete([downloadId, chunk.index]);
        deleteRequest.onsuccess = () => {
          completed++;
          if (completed === total) {
            resolve();
          }
        };
        deleteRequest.onerror = () => {
          reject(new Error(`Failed to delete chunk: ${deleteRequest.error}`));
        };
      });
    });

    db.close();
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
    const transaction = db.transaction([STORE_NAME], "readonly");
    const store = transaction.objectStore(STORE_NAME);
    const index = store.index("downloadId");

    const count = await new Promise<number>((resolve, reject) => {
      const request = index.count(downloadId);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () =>
        reject(new Error(`Failed to count chunks: ${request.error}`));
    });

    db.close();
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
    const transaction = db.transaction([STORE_NAME], "readonly");
    const store = transaction.objectStore(STORE_NAME);

    const record = await new Promise<ChunkRecord | undefined>(
      (resolve, reject) => {
        const request = store.get([downloadId, index]);
        request.onsuccess = () =>
          resolve(request.result as ChunkRecord | undefined);
        request.onerror = () =>
          reject(new Error(`Failed to read chunk: ${request.error}`));
      },
    );

    db.close();

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
