/**
 * IndexedDB database connection
 * Shared connection for all database models
 */

const DB_NAME = "media-bridge";
const DB_VERSION = 3;
export const CHUNKS_STORE_NAME = "chunks";
export const DOWNLOADS_STORE_NAME = "downloads";

let cachedDb: IDBDatabase | null = null;

/**
 * Open IndexedDB database with connection reuse
 * Returns a cached connection if one is already open, otherwise opens a new one.
 * Creates both chunks and downloads stores if they don't exist.
 */
export function openDatabase(): Promise<IDBDatabase> {
  // Return cached connection if still open
  if (cachedDb) {
    try {
      // Test if connection is still usable by attempting a transaction
      cachedDb.transaction([CHUNKS_STORE_NAME], "readonly");
      return Promise.resolve(cachedDb);
    } catch {
      // Connection is stale, discard it
      cachedDb = null;
    }
  }

  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onerror = () => {
      reject(new Error(`Failed to open IndexedDB: ${request.error}`));
    };

    request.onsuccess = () => {
      const db = request.result;

      // Close cached connection on versionchange (required for upgrades)
      db.onversionchange = () => {
        db.close();
        cachedDb = null;
      };

      cachedDb = db;
      resolve(db);
    };

    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result;

      // Create chunks store if it doesn't exist
      if (!db.objectStoreNames.contains(CHUNKS_STORE_NAME)) {
        const chunksStore = db.createObjectStore(CHUNKS_STORE_NAME, {
          keyPath: ["downloadId", "index"],
        });
        chunksStore.createIndex("downloadId", "downloadId", { unique: false });
        chunksStore.createIndex("index", "index", { unique: false });
      }

      // Create downloads store if it doesn't exist
      if (!db.objectStoreNames.contains(DOWNLOADS_STORE_NAME)) {
        const downloadsStore = db.createObjectStore(DOWNLOADS_STORE_NAME, {
          keyPath: "id",
        });
        downloadsStore.createIndex("url", "url", { unique: false });
        downloadsStore.createIndex("updatedAt", "updatedAt", { unique: false });
        downloadsStore.createIndex("createdAt", "createdAt", { unique: false });
      }
    };
  });
}

