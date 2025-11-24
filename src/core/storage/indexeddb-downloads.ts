/**
 * Download state management using IndexedDB
 * Uses the same database as chunks for efficiency
 */

import { ChromeStorage } from "./chrome-storage";
import { DownloadState, DownloadProgress } from "../types";
import { logger } from "../utils/logger";
import { normalizeUrl } from "../utils/url-utils";

const DB_NAME = "media-bridge";
const DB_VERSION = 2;
const STORE_NAME = "downloads";
const STORAGE_KEY_DOWNLOAD_QUEUE = "download_queue";

/**
 * Open IndexedDB database (shared with chunks)
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
      // Create downloads store if it doesn't exist
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, {
          keyPath: "id",
        });
        // Create indexes for efficient queries
        store.createIndex("url", "url", { unique: false });
        store.createIndex("updatedAt", "updatedAt", { unique: false });
        store.createIndex("createdAt", "createdAt", { unique: false });
        // Note: videoId and stage are nested, so we'll query and filter instead
      }
    };
  });
}

/**
 * Get all download states
 */
export async function getAllDownloads(): Promise<DownloadState[]> {
  try {
    const db = await openDatabase();
    const transaction = db.transaction([STORE_NAME], "readonly");
    const store = transaction.objectStore(STORE_NAME);

    const downloads = await new Promise<DownloadState[]>((resolve, reject) => {
      const request = store.getAll();
      request.onsuccess = () => {
        resolve(request.result as DownloadState[]);
      };
      request.onerror = () => {
        reject(new Error(`Failed to get downloads: ${request.error}`));
      };
    });

    db.close();
    return downloads;
  } catch (error) {
    logger.error("Failed to get all downloads:", error);
    return [];
  }
}

/**
 * Get download state by ID
 */
export async function getDownload(id: string): Promise<DownloadState | null> {
  try {
    const db = await openDatabase();
    const transaction = db.transaction([STORE_NAME], "readonly");
    const store = transaction.objectStore(STORE_NAME);

    const download = await new Promise<DownloadState | null>(
      (resolve, reject) => {
        const request = store.get(id);
        request.onsuccess = () => {
          resolve((request.result as DownloadState) || null);
        };
        request.onerror = () => {
          reject(new Error(`Failed to get download: ${request.error}`));
        };
      },
    );

    db.close();
    return download;
  } catch (error) {
    logger.error(`Failed to get download ${id}:`, error);
    return null;
  }
}

/**
 * Get download state by URL
 * Uses normalized URLs (removes hash fragments) for comparison
 */
export async function getDownloadByUrl(
  url: string,
): Promise<DownloadState | null> {
  try {
    const downloads = await getAllDownloads();
    const normalizedUrl = normalizeUrl(url);
    return (
      downloads.find((d) => normalizeUrl(d.url) === normalizedUrl) ?? null
    );
  } catch (error) {
    logger.error(`Failed to get download by URL ${url}:`, error);
    return null;
  }
}

/**
 * Get download state by videoId
 * Matches downloads by the unique video ID
 */
export async function getDownloadByVideoId(
  videoId: string,
): Promise<DownloadState | null> {
  try {
    const downloads = await getAllDownloads();
    return downloads.find((d) => d.metadata.videoId === videoId) ?? null;
  } catch (error) {
    logger.error(`Failed to get download by videoId ${videoId}:`, error);
    return null;
  }
}

/**
 * Store or update download state
 */
export async function storeDownload(state: DownloadState): Promise<void> {
  try {
    const db = await openDatabase();
    const transaction = db.transaction([STORE_NAME], "readwrite");
    const store = transaction.objectStore(STORE_NAME);

    const updatedState: DownloadState = {
      ...state,
      updatedAt: Date.now(),
    };

    await new Promise<void>((resolve, reject) => {
      const request = store.put(updatedState);
      request.onsuccess = () => {
        resolve();
      };
      request.onerror = () => {
        reject(new Error(`Failed to store download: ${request.error}`));
      };
    });

    db.close();
    logger.debug(`Stored download state for ${state.id}`);
  } catch (error) {
    logger.error(`Failed to store download state:`, error);
    throw error;
  }
}

/**
 * Update download progress
 */
export async function updateDownloadProgress(
  id: string,
  progress: Partial<DownloadProgress>,
): Promise<void> {
  const state = await getDownload(id);
  if (!state) {
    logger.warn(`Download ${id} not found for progress update`);
    return;
  }

  state.progress = {
    ...state.progress,
    ...progress,
  };
  await storeDownload(state);
}

/**
 * Delete download state
 */
export async function deleteDownload(id: string): Promise<void> {
  try {
    const db = await openDatabase();
    const transaction = db.transaction([STORE_NAME], "readwrite");
    const store = transaction.objectStore(STORE_NAME);

    await new Promise<void>((resolve, reject) => {
      const request = store.delete(id);
      request.onsuccess = () => {
        resolve();
      };
      request.onerror = () => {
        reject(new Error(`Failed to delete download: ${request.error}`));
      };
    });

    db.close();
    logger.debug(`Deleted download state for ${id}`);
  } catch (error) {
    logger.error(`Failed to delete download state:`, error);
    throw error;
  }
}

/**
 * Clear all downloads
 */
export async function clearAllDownloads(): Promise<void> {
  try {
    const db = await openDatabase();
    const transaction = db.transaction([STORE_NAME], "readwrite");
    const store = transaction.objectStore(STORE_NAME);

    await new Promise<void>((resolve, reject) => {
      const request = store.clear();
      request.onsuccess = () => {
        resolve();
      };
      request.onerror = () => {
        reject(new Error(`Failed to clear downloads: ${request.error}`));
      };
    });

    db.close();
    // Also clear the queue
    await ChromeStorage.remove(STORAGE_KEY_DOWNLOAD_QUEUE);
  } catch (error) {
    logger.error("Failed to clear all downloads:", error);
    throw error;
  }
}

/**
 * Get download queue (still uses Chrome Storage as it's small)
 */
export async function getDownloadQueue(): Promise<string[]> {
  const queue = await ChromeStorage.get<string[]>(STORAGE_KEY_DOWNLOAD_QUEUE);
  return queue || [];
}

/**
 * Add to download queue
 */
export async function addToDownloadQueue(id: string): Promise<void> {
  const queue = await getDownloadQueue();
  if (!queue.includes(id)) {
    queue.push(id);
    await ChromeStorage.set(STORAGE_KEY_DOWNLOAD_QUEUE, queue);
  }
}

/**
 * Remove from download queue
 */
export async function removeFromDownloadQueue(id: string): Promise<void> {
  const queue = await getDownloadQueue();
  const filtered = queue.filter((qId) => qId !== id);
  await ChromeStorage.set(STORAGE_KEY_DOWNLOAD_QUEUE, filtered);
}

