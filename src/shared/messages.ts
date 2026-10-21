/**
 * Message types for communication between extension components
 */

import { VideoMetadata, DownloadStage } from "../core/types";

export type CloudProvider = 'googleDrive' | 's3';

export enum MessageType {
  // Download messages
  DOWNLOAD_REQUEST = "DOWNLOAD_REQUEST",
  DOWNLOAD_PROGRESS = "DOWNLOAD_PROGRESS",
  DOWNLOAD_COMPLETE = "DOWNLOAD_COMPLETE",
  DOWNLOAD_FAILED = "DOWNLOAD_FAILED",
  CANCEL_DOWNLOAD = "CANCEL_DOWNLOAD",

  // State messages
  GET_DOWNLOADS = "GET_DOWNLOADS",
  CLEAR_DOWNLOADS = "CLEAR_DOWNLOADS",

  // Video detection
  VIDEO_DETECTED = "VIDEO_DETECTED",
  VIDEO_REMOVED = "VIDEO_REMOVED",
  GET_DETECTED_VIDEOS = "GET_DETECTED_VIDEOS",
  START_DOWNLOAD = "START_DOWNLOAD",
  EXTRACT_VIDEO_URL = "EXTRACT_VIDEO_URL",
  NETWORK_URL_DETECTED = "NETWORK_URL_DETECTED",

  // Cloud upload
  UPLOAD_REQUEST = "UPLOAD_REQUEST",
  UPLOAD_PROGRESS = "UPLOAD_PROGRESS",
  UPLOAD_COMPLETE = "UPLOAD_COMPLETE",
  UPLOAD_FAILED = "UPLOAD_FAILED",
  CANCEL_UPLOAD = "CANCEL_UPLOAD",

  // Config
  GET_CONFIG = "GET_CONFIG",
  SAVE_CONFIG = "SAVE_CONFIG",

  // Auth
  AUTH_REQUEST = "AUTH_REQUEST",
  AUTH_COMPLETE = "AUTH_COMPLETE",
  AUTH_FAILED = "AUTH_FAILED",

  // Fetch resource (for CORS bypass in content scripts)
  FETCH_RESOURCE = "FETCH_RESOURCE",

  // Offscreen messages
  OFFSCREEN_PROCESS_HLS = "OFFSCREEN_PROCESS_HLS",
  OFFSCREEN_PROCESS_HLS_RESPONSE = "OFFSCREEN_PROCESS_HLS_RESPONSE",
  OFFSCREEN_PROCESS_M3U8 = "OFFSCREEN_PROCESS_M3U8",
  OFFSCREEN_PROCESS_M3U8_RESPONSE = "OFFSCREEN_PROCESS_M3U8_RESPONSE",
  OFFSCREEN_PROCESS_DASH = "OFFSCREEN_PROCESS_DASH",
  OFFSCREEN_PROCESS_DASH_RESPONSE = "OFFSCREEN_PROCESS_DASH_RESPONSE",

  // Icon management
  SET_ICON_BLUE = "SET_ICON_BLUE",
  SET_ICON_GRAY = "SET_ICON_GRAY",

  // Live recording
  START_RECORDING = "START_RECORDING",
  STOP_RECORDING = "STOP_RECORDING",

  // Stop and save partial download
  STOP_AND_SAVE_DOWNLOAD = "STOP_AND_SAVE_DOWNLOAD",

  // Blob URL revocation (must be sent to offscreen document — not service worker)
  REVOKE_BLOB_URL = "REVOKE_BLOB_URL",

  // FFmpeg pre-warm
  WARMUP_FFMPEG = "WARMUP_FFMPEG",

  // URL health check (options page manifest check feature)
  CHECK_URL = "CHECK_URL",

  // Page-initiated downloads (overlay button) and bulk actions
  DOWNLOAD_ALL_DETECTED = "DOWNLOAD_ALL_DETECTED",

  // MediaSource stream capture
  CAPTURE_GET_STATUS = "CAPTURE_GET_STATUS", // popup -> content (per frame): capture state
  CAPTURE_COMMAND = "CAPTURE_COMMAND", // popup -> content (per frame): start/stop/discard/boost
  CAPTURE_PREPARE = "CAPTURE_PREPARE", // content -> SW: allocate token + downloadId
  CAPTURE_FINALIZE = "CAPTURE_FINALIZE", // bridge -> SW: chunks stored, mux and save

  // Content script finished init in a frame — SW replays network detections it missed
  CONTENT_READY = "CONTENT_READY",
}

export type CaptureAction = "start" | "boost" | "stop-save" | "discard";

export interface CaptureTrackStatus {
  kind: "video" | "audio" | "unknown";
  mime: string;
  segments: number;
  bytes: number;
}

export interface CaptureSessionStatus {
  id: number;
  tracks: CaptureTrackStatus[];
  bytes: number;
  /** Media element duration in seconds, when known */
  duration?: number;
  /** Seconds of media covered by captured video segments (approximate) */
  capturedSeconds?: number;
  /** EME/DRM detected — capture is refused */
  drm: boolean;
  width?: number;
  height?: number;
}

export interface CaptureFrameStatus {
  frameId: number;
  armed: boolean;
  limitReached: boolean;
  saving: boolean;
  sessions: CaptureSessionStatus[];
  title: string;
  pageUrl: string;
}

export interface BaseMessage {
  type: MessageType;
  payload?: any;
}

export interface DownloadRequestMessage extends BaseMessage {
  type: MessageType.DOWNLOAD_REQUEST;
  payload: {
    url: string;
    filename?: string;
    metadata: VideoMetadata;
    tabTitle?: string;
    website?: string;
  };
}

export interface DownloadProgressMessage extends BaseMessage {
  type: MessageType.DOWNLOAD_PROGRESS;
  payload: {
    id: string;
    progress: {
      stage: DownloadStage;
      downloaded?: number;
      total?: number;
      percentage?: number;
      message?: string;
    };
  };
}

export type ExtensionMessage =
  | DownloadRequestMessage
  | DownloadProgressMessage
  | BaseMessage;
