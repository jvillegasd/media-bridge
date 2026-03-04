/**
 * Options-page-only constants.
 *
 * Values here are used exclusively within the options UI.
 * Cross-module constants live in src/shared/constants.ts.
 */

export const TOAST_DURATION_MS = 3_000;
export const MS_PER_DAY = 86_400_000;

// ---- Recording settings validation bounds ----
export const MIN_POLL_MIN_MS = 500;
export const MAX_POLL_MIN_MS = 5_000;
export const MIN_POLL_MAX_MS = 2_000;
export const MAX_POLL_MAX_MS = 30_000;
export const MIN_POLL_FRACTION = 0.25;
export const MAX_POLL_FRACTION = 1.0;

// ---- Advanced settings validation bounds ----
export const MIN_MAX_RETRIES = 1;
export const MAX_MAX_RETRIES = 10;
export const MIN_RETRY_DELAY_MS = 50;
export const MAX_RETRY_DELAY_MS = 1_000;
export const MIN_RETRY_BACKOFF_FACTOR = 1.0;
export const MAX_RETRY_BACKOFF_FACTOR = 3.0;
export const MIN_FAILURE_RATE = 0.05;
export const MAX_FAILURE_RATE = 0.5;
export const MIN_DETECTION_CACHE_SIZE = 100;
export const MAX_DETECTION_CACHE_SIZE = 2_000;
export const MIN_MASTER_PLAYLIST_CACHE_SIZE = 10;
export const MAX_MASTER_PLAYLIST_CACHE_SIZE = 200;
export const MIN_DB_SYNC_INTERVAL_MS = 100;
export const MAX_DB_SYNC_INTERVAL_MS = 2_000;
