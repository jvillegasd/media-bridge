/**
 * Type definitions for Media Bridge Extension
 */

export type VideoFormat = 'hls' | 'dash' | 'direct' | 'unknown';

export interface VideoMetadata {
  url: string;
  title?: string;
  duration?: number;
  format: VideoFormat;
  quality?: string;
  width?: number;
  height?: number;
}

export interface DownloadProgress {
  url: string;
  stage: 'detecting' | 'downloading' | 'merging' | 'saving' | 'uploading' | 'completed' | 'failed';
  downloaded?: number;
  total?: number;
  percentage?: number;
  message?: string;
  error?: string;
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

export interface SegmentInfo {
  url: string;
  sequence: number;
  duration?: number;
  byteRange?: {
    start: number;
    end: number;
  };
}

export interface HLSPlaylist {
  isMasterPlaylist: boolean;
  variants?: HLSVariant[];
  segments: SegmentInfo[];
  totalDuration?: number;
  baseUrl: string;
}

export interface HLSVariant {
  url: string;
  bandwidth: number;
  resolution?: string;
  codecs?: string;
}

export interface DASHManifest {
  video: DASHRepresentation[];
  audio: DASHRepresentation[];
  baseUrl: string;
}

export interface DASHRepresentation {
  id: string;
  type: 'video' | 'audio';
  bandwidth: number;
  width?: number;
  height?: number;
  codecs?: string;
  segments: {
    initUrl?: string;
    segments: SegmentInfo[];
  };
}

