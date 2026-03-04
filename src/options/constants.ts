/**
 * Options-page-only constants.
 *
 * Values here are used exclusively within the options UI.
 * Cross-module constants live in src/shared/constants.ts.
 */

/** Duration toast notifications are visible (ms — internal only, not user-facing) */
export const TOAST_DURATION_MS = 3_000;

export const MS_PER_DAY = 86_400_000;

// ---- FFmpeg timeout UI bounds (seconds) ----
export const DEFAULT_FFMPEG_TIMEOUT_S = 900;   // 15 min
export const MIN_FFMPEG_TIMEOUT_S = 300;        // 5 min
export const MAX_FFMPEG_TIMEOUT_S = 3_600;      // 60 min

// ---- Recording settings validation bounds (seconds) ----
export const MIN_POLL_MIN_S = 0.5;
export const MAX_POLL_MIN_S = 5;
export const MIN_POLL_MAX_S = 2;
export const MAX_POLL_MAX_S = 30;
export const MIN_POLL_FRACTION = 0.25;
export const MAX_POLL_FRACTION = 1.0;

// ---- Advanced settings validation bounds ----
export const MIN_MAX_RETRIES = 1;
export const MAX_MAX_RETRIES = 10;
export const MIN_RETRY_DELAY_S = 0.05;   // 50 ms
export const MAX_RETRY_DELAY_S = 1;       // 1 000 ms
export const MIN_RETRY_BACKOFF_FACTOR = 1.0;
export const MAX_RETRY_BACKOFF_FACTOR = 3.0;
export const MIN_FAILURE_RATE = 0.05;
export const MAX_FAILURE_RATE = 0.5;
export const MIN_DETECTION_CACHE_SIZE = 100;
export const MAX_DETECTION_CACHE_SIZE = 2_000;
export const MIN_MASTER_PLAYLIST_CACHE_SIZE = 10;
export const MAX_MASTER_PLAYLIST_CACHE_SIZE = 200;
export const MIN_DB_SYNC_S = 0.1;   // 100 ms
export const MAX_DB_SYNC_S = 2;     // 2 000 ms
