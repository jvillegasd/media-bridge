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

// ---- Fetch retry (configurable via Advanced settings) ----

/** Maximum number of retry attempts for segment/manifest fetches */
export const DEFAULT_MAX_RETRIES = 3;

// ---- Live recording polling (configurable via Recording settings) ----

/** Default HLS poll interval before #EXT-X-TARGETDURATION is known */
export const DEFAULT_HLS_POLL_INTERVAL_MS = 3_000;

/** Minimum allowed HLS poll interval */
export const DEFAULT_MIN_POLL_MS = 1_000;

/** Maximum allowed HLS poll interval */
export const DEFAULT_MAX_POLL_MS = 10_000;

/** Fraction of #EXT-X-TARGETDURATION used to compute poll cadence */
export const DEFAULT_POLL_FRACTION = 0.5;

// ---- Detection deduplication caches (configurable via Advanced settings) ----

/** Max distinct URL path keys tracked by HLS/DASH detection handlers */
export const DEFAULT_DETECTION_CACHE_SIZE = 500;

/** Max master playlists held in memory by HLS detection handler */
export const DEFAULT_MASTER_PLAYLIST_CACHE_SIZE = 50;

/** IDB write interval during segment downloads (configurable via Advanced settings) */
export const DEFAULT_DB_SYNC_INTERVAL_MS = 500;

/** Direct media sniffed from the network smaller than this (bytes) is ignored as noise */
export const DEFAULT_MIN_DIRECT_SIZE_KB = 512;

// ---- Stream capture (MediaSource) ----

/** Default per-page memory cap for stream capture, in MB */
export const DEFAULT_CAPTURE_MAX_MB = 1536;

/** Bounds for the capture memory cap setting, in MB */
export const MIN_CAPTURE_MAX_MB = 128;
export const MAX_CAPTURE_MAX_MB = 4096;

/** window.postMessage channel shared by the MAIN-world capture hook and the content script */
export const CAPTURE_CHANNEL = "__media_bridge_capture__";

/** window.postMessage channel the content script uses to hand a port to the capture bridge */
export const CAPTURE_BRIDGE_CHANNEL = "__media_bridge_bridge__";

/** Id of the dynamically registered MAIN-world content script */
export const CAPTURE_HOOK_SCRIPT_ID = "media-bridge-mse-capture";

/** A prepared capture must be claimed by the bridge within this window */
export const CAPTURE_CLAIM_TIMEOUT_MS = 60_000;

/** A claimed capture with no bridge activity for this long is abandoned */
export const CAPTURE_IDLE_TIMEOUT_MS = 60_000;

/** Overhead allowed on top of the memory cap when the bridge writes a capture (init segments etc.) */
export const CAPTURE_BYTES_MARGIN = 64 * 1024 * 1024;

/** Hard upper bound on chunks per track written by one capture */
export const CAPTURE_MAX_CHUNKS_PER_TRACK = 100_000;

// ---- Chrome storage keys ----

export const STORAGE_CONFIG_KEY = "storage_config";

/** Default Google Drive upload folder name */
export const DEFAULT_GOOGLE_DRIVE_FOLDER_NAME = "MediaBridge Uploads";
