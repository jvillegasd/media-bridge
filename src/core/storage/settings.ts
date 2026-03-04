/**
 * Resolved application settings.
 *
 * Always import settings via `loadSettings()` — never read StorageConfig directly.
 * Every field here has a concrete type with defaults applied, so consumers never
 * need null-checks or scattered `?? DEFAULT_X` fallbacks.
 */

import { StorageConfig, EncryptedBlob } from "../types";
import { ChromeStorage } from "./chrome-storage";
import {
  DEFAULT_MAX_CONCURRENT,
  DEFAULT_FFMPEG_TIMEOUT_MS,
  DEFAULT_MAX_RETRIES,
  INITIAL_RETRY_DELAY_MS,
  RETRY_BACKOFF_FACTOR,
  MAX_FRAGMENT_FAILURE_RATE,
  DEFAULT_MIN_POLL_MS,
  DEFAULT_MAX_POLL_MS,
  DEFAULT_POLL_FRACTION,
  DEFAULT_DETECTION_CACHE_SIZE,
  DEFAULT_MASTER_PLAYLIST_CACHE_SIZE,
  DEFAULT_DB_SYNC_INTERVAL_MS,
  STORAGE_CONFIG_KEY,
  DEFAULT_GOOGLE_DRIVE_FOLDER_NAME,
} from "../../shared/constants";

export interface AppSettings {
  ffmpegTimeout: number;
  maxConcurrent: number;
  historyEnabled: boolean;

  googleDrive: {
    enabled: boolean;
    targetFolderId?: string;
    createFolderIfNotExists: boolean;
    folderName: string;
  };

  s3: {
    enabled: boolean;
    bucket?: string;
    region?: string;
    endpoint?: string;
    accessKeyId?: string;
    secretAccessKey?: string;
    secretKeyEncrypted?: EncryptedBlob;
    prefix?: string;
  };

  recording: {
    minPollIntervalMs: number;
    maxPollIntervalMs: number;
    pollFraction: number;
  };

  notifications: {
    notifyOnCompletion: boolean;
    autoOpenFile: boolean;
  };

  advanced: {
    maxRetries: number;
    retryDelayMs: number;
    retryBackoffFactor: number;
    fragmentFailureRate: number;
    detectionCacheSize: number;
    masterPlaylistCacheSize: number;
    dbSyncIntervalMs: number;
  };
}

export async function loadSettings(): Promise<AppSettings> {
  const raw = await ChromeStorage.get<StorageConfig>(STORAGE_CONFIG_KEY);

  return {
    ffmpegTimeout: raw?.ffmpegTimeout ?? DEFAULT_FFMPEG_TIMEOUT_MS,
    maxConcurrent: raw?.maxConcurrent ?? DEFAULT_MAX_CONCURRENT,
    historyEnabled: raw?.historyEnabled ?? true,

    googleDrive: {
      enabled: raw?.googleDrive?.enabled ?? false,
      targetFolderId: raw?.googleDrive?.targetFolderId,
      createFolderIfNotExists: raw?.googleDrive?.createFolderIfNotExists ?? false,
      folderName: raw?.googleDrive?.folderName ?? DEFAULT_GOOGLE_DRIVE_FOLDER_NAME,
    },

    s3: {
      enabled: raw?.s3?.enabled ?? false,
      bucket: raw?.s3?.bucket,
      region: raw?.s3?.region,
      endpoint: raw?.s3?.endpoint,
      accessKeyId: raw?.s3?.accessKeyId,
      secretAccessKey: raw?.s3?.secretAccessKey,
      secretKeyEncrypted: raw?.s3?.secretKeyEncrypted,
      prefix: raw?.s3?.prefix,
    },

    recording: {
      minPollIntervalMs: raw?.recording?.minPollIntervalMs ?? DEFAULT_MIN_POLL_MS,
      maxPollIntervalMs: raw?.recording?.maxPollIntervalMs ?? DEFAULT_MAX_POLL_MS,
      pollFraction: raw?.recording?.pollFraction ?? DEFAULT_POLL_FRACTION,
    },

    notifications: {
      notifyOnCompletion: raw?.notifications?.notifyOnCompletion ?? false,
      autoOpenFile: raw?.notifications?.autoOpenFile ?? false,
    },

    advanced: {
      maxRetries: raw?.advanced?.maxRetries ?? DEFAULT_MAX_RETRIES,
      retryDelayMs: raw?.advanced?.retryDelayMs ?? INITIAL_RETRY_DELAY_MS,
      retryBackoffFactor: raw?.advanced?.retryBackoffFactor ?? RETRY_BACKOFF_FACTOR,
      fragmentFailureRate: raw?.advanced?.fragmentFailureRate ?? MAX_FRAGMENT_FAILURE_RATE,
      detectionCacheSize: raw?.advanced?.detectionCacheSize ?? DEFAULT_DETECTION_CACHE_SIZE,
      masterPlaylistCacheSize: raw?.advanced?.masterPlaylistCacheSize ?? DEFAULT_MASTER_PLAYLIST_CACHE_SIZE,
      dbSyncIntervalMs: raw?.advanced?.dbSyncIntervalMs ?? DEFAULT_DB_SYNC_INTERVAL_MS,
    },
  };
}
