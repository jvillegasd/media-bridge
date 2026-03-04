/**
 * Type definitions for Media Bridge Extension
 */

export enum VideoFormat {
  DIRECT = "direct",
  HLS = "hls",
  M3U8 = "m3u8",
  DASH = "dash",
  UNKNOWN = "unknown",
}

export interface VideoMetadata {
  url: string;
  title?: string;
  duration?: number;
  format: VideoFormat;
  quality?: string;
  width?: number;
  height?: number;
  resolution?: string; // e.g., "1920x1080", "1080p"
  pageUrl: string; // URL of the page where video was detected
  thumbnail?: string; // Thumbnail/preview image URL
  videoId?: string; // Unique identifier for this video instance
  fileExtension?: string; // Detected file extension (e.g., "mp4", "webm")
  hasDrm?: boolean; // Indicates if the video is DRM-protected
  unsupported?: boolean; // Indicates if the manifest uses unsupported encryption methods
  isLive?: boolean; // Indicates if the stream is a live stream (no #EXT-X-ENDLIST)
}

export interface VideoQuality {
  url: string; // Playlist/manifest URL for this quality
  bandwidth: number; // Bitrate in bits per second
  resolution?: string; // e.g., "1920x1080"
  width?: number;
  height?: number;
  quality?: string; // Human-readable quality label (e.g., "1080p", "720p")
  codecs?: string;
}

/**
 * Download stage enum for type-safe stage checking
 */
export enum DownloadStage {
  DETECTING = "detecting",
  DOWNLOADING = "downloading",
  RECORDING = "recording",
  MERGING = "merging",
  SAVING = "saving",
  UPLOADING = "uploading",
  COMPLETED = "completed",
  FAILED = "failed",
  CANCELLED = "cancelled",
}

export interface DownloadProgress {
  url: string;
  stage: DownloadStage;
  downloaded?: number;
  total?: number;
  percentage?: number;
  message?: string;
  error?: string;
  speed?: number; // Download speed in bytes per second
  lastUpdateTime?: number; // Timestamp for speed calculation
  lastDownloaded?: number; // Last downloaded bytes for speed calculation
  segmentsCollected?: number; // Number of segments collected during live recording
}

export interface DownloadState {
  id: string;
  url: string;
  metadata: VideoMetadata;
  progress: DownloadProgress;
  localPath?: string;
  cloudId?: string;
  isManual?: boolean; // Indicates if download was started from manual/manifest tab
  chromeDownloadId?: number; // Chrome downloads API ID for reliable cancellation (only set when Chrome API is used)
  createdAt: number;
  updatedAt: number;
}

export interface StorageConfig {
  googleDrive?: {
    enabled: boolean;
    targetFolderId?: string;
    createFolderIfNotExists?: boolean;
    folderName?: string;
  };
  ffmpegTimeout?: number; // FFmpeg processing timeout in milliseconds (default: 15 minutes)
  maxConcurrent?: number; // Max concurrent segment downloads (default: 3)
  historyEnabled?: boolean; // Whether to persist completed/failed/cancelled downloads (default: true)
  s3?: {
    enabled: boolean;
    bucket?: string;
    region?: string;
    endpoint?: string; // For S3-compatible providers (Cloudflare R2, Backblaze, etc.)
    accessKeyId?: string;
    secretAccessKey?: string;
    prefix?: string;
  };
  recording?: {
    minPollIntervalMs?: number; // Minimum HLS poll interval (default: 1000ms)
    maxPollIntervalMs?: number; // Maximum HLS poll interval (default: 10000ms)
    pollFraction?: number; // Fraction of #EXT-X-TARGETDURATION used for poll cadence (default: 0.5)
  };
  notifications?: {
    notifyOnCompletion?: boolean; // Show OS notification when download finishes (default: false)
    autoOpenFile?: boolean; // Open file in Finder/Explorer after download (default: false)
  };
  advanced?: {
    maxRetries?: number; // Max segment/manifest fetch retries (default: 3)
    retryDelayMs?: number; // Initial retry backoff delay in ms (default: 100)
    retryBackoffFactor?: number; // Exponential backoff multiplier (default: 1.15)
    fragmentFailureRate?: number; // Max tolerated fragment failure rate 0–1 (default: 0.1)
    detectionCacheSize?: number; // Max URL path keys tracked per page (default: 500)
    masterPlaylistCacheSize?: number; // Max master playlists in memory (default: 50)
    dbSyncIntervalMs?: number; // IDB write throttle during segment downloads (default: 500)
  };
}

export interface MessageRequest {
  type: string;
  payload?: any;
}

export interface MessageResponse {
  success: boolean;
  data?: any;
  error?: string;
}

// HLS Playlist Types
export type LevelType = "stream" | "audio";

export interface Fragment {
  index: number;
  key: {
    iv: string | null;
    uri: string | null;
  };
  uri: string;
}

export interface Level {
  type: LevelType;
  id: string;
  playlistID: string;
  uri: string;
  bitrate?: number;
  fps?: number;
  height?: number;
  width?: number;
}

