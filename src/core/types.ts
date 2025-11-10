/**
 * Type definitions for Media Bridge Extension
 */

export type VideoFormat = 'direct' | 'hls' | 'unknown';

export interface VideoMetadata {
  url: string;
  title?: string;
  duration?: number;
  format: VideoFormat;
  quality?: string;
  width?: number;
  height?: number;
  resolution?: string; // e.g., "1920x1080", "1080p"
  pageUrl?: string; // URL of the page where video was detected
  thumbnail?: string; // Thumbnail/preview image URL
  videoId?: string; // Unique identifier for this video instance
  fileExtension?: string; // Detected file extension (e.g., "mp4", "webm")
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

export interface DownloadProgress {
  url: string;
  stage: 'detecting' | 'downloading' | 'merging' | 'saving' | 'uploading' | 'completed' | 'failed';
  downloaded?: number;
  total?: number;
  percentage?: number;
  message?: string;
  error?: string;
  speed?: number; // Download speed in bytes per second
  lastUpdateTime?: number; // Timestamp for speed calculation
  lastDownloaded?: number; // Last downloaded bytes for speed calculation
}

export interface DownloadState {
  id: string;
  url: string;
  metadata?: VideoMetadata;
  progress: DownloadProgress;
  localPath?: string;
  cloudId?: string;
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

export type FetchFn<Data> = () => Promise<Data>;

// HLS Playlist Types
export type LevelType = 'stream' | 'audio';

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

