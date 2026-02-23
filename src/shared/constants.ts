/**
 * Shared constants for the Media Bridge extension.
 *
 * Values here are used across multiple modules. File-specific constants
 * remain co-located with their files.
 */

// ---- Extension-configurable defaults (backed by chrome.storage) ----

/** Default max concurrent fragment downloads (configurable in settings) */
export const DEFAULT_MAX_CONCURRENT = 3;

/** Default FFmpeg processing timeout in milliseconds (configurable in settings) */
export const DEFAULT_FFMPEG_TIMEOUT_MS = 900_000; // 15 minutes

/** Default FFmpeg timeout expressed in minutes (for the settings UI) */
export const DEFAULT_FFMPEG_TIMEOUT_MINUTES = 15;

/** Minimum FFmpeg timeout in minutes (settings UI clamp) */
export const MIN_FFMPEG_TIMEOUT_MINUTES = 5;

/** Maximum FFmpeg timeout in minutes (settings UI clamp) */
export const MAX_FFMPEG_TIMEOUT_MINUTES = 60;

/** Milliseconds per minute — avoids bare 60000 literals */
export const MS_PER_MINUTE = 60_000;

// ---- Download pipeline ----

/** Fragment failure rate above which the download is aborted */
export const MAX_FRAGMENT_FAILURE_RATE = 0.1;

/** Progress percentage set when entering the SAVING stage */
export const SAVING_STAGE_PERCENTAGE = 95;

// ---- Service worker keep-alive ----

/** Heartbeat interval to prevent service worker termination */
export const KEEPALIVE_INTERVAL_MS = 20_000;

// ---- Fetch retry ----

/** Initial retry backoff delay for failed fetch requests */
export const INITIAL_RETRY_DELAY_MS = 100;

/** Exponential backoff multiplier applied after each fetch retry */
export const RETRY_BACKOFF_FACTOR = 1.15;

// ---- Chrome storage keys ----

export const STORAGE_CONFIG_KEY = "storage_config";
export const MAX_CONCURRENT_KEY = "max_concurrent";
