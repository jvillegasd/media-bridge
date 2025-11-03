/**
 * Message types for communication between extension components
 */

export enum MessageType {
  // Download messages
  DOWNLOAD_REQUEST = 'DOWNLOAD_REQUEST',
  DOWNLOAD_PROGRESS = 'DOWNLOAD_PROGRESS',
  DOWNLOAD_COMPLETE = 'DOWNLOAD_COMPLETE',
  DOWNLOAD_FAILED = 'DOWNLOAD_FAILED',
  CANCEL_DOWNLOAD = 'CANCEL_DOWNLOAD',
  
  // State messages
  GET_DOWNLOADS = 'GET_DOWNLOADS',
  CLEAR_DOWNLOADS = 'CLEAR_DOWNLOADS',
  
  // Video detection
  VIDEO_DETECTED = 'VIDEO_DETECTED',
  START_DOWNLOAD = 'START_DOWNLOAD',
  
  // Cloud upload
  UPLOAD_REQUEST = 'UPLOAD_REQUEST',
  UPLOAD_PROGRESS = 'UPLOAD_PROGRESS',
  UPLOAD_COMPLETE = 'UPLOAD_COMPLETE',
  UPLOAD_FAILED = 'UPLOAD_FAILED',
  
  // Config
  GET_CONFIG = 'GET_CONFIG',
  SAVE_CONFIG = 'SAVE_CONFIG',
  
  // Auth
  AUTH_REQUEST = 'AUTH_REQUEST',
  AUTH_COMPLETE = 'AUTH_COMPLETE',
  AUTH_FAILED = 'AUTH_FAILED',
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
    format?: string;
    uploadToDrive?: boolean;
  };
}

export interface DownloadProgressMessage extends BaseMessage {
  type: MessageType.DOWNLOAD_PROGRESS;
  payload: {
    id: string;
    progress: {
      stage: string;
      downloaded?: number;
      total?: number;
      percentage?: number;
      message?: string;
    };
  };
}

export type ExtensionMessage = DownloadRequestMessage | DownloadProgressMessage | BaseMessage;

