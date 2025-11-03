/**
 * Custom error classes for the extension
 */

export class MediaBridgeError extends Error {
  constructor(message: string, public code?: string) {
    super(message);
    this.name = this.constructor.name;
    Object.setPrototypeOf(this, MediaBridgeError.prototype);
  }
}

export class NetworkError extends MediaBridgeError {
  constructor(message: string, public statusCode?: number) {
    super(message, 'NETWORK_ERROR');
    this.name = 'NetworkError';
  }
}

export class ParseError extends MediaBridgeError {
  constructor(message: string) {
    super(message, 'PARSE_ERROR');
    this.name = 'ParseError';
  }
}

export class DownloadError extends MediaBridgeError {
  constructor(message: string, public url?: string) {
    super(message, 'DOWNLOAD_ERROR');
    this.name = 'DownloadError';
  }
}

export class MergeError extends MediaBridgeError {
  constructor(message: string) {
    super(message, 'MERGE_ERROR');
    this.name = 'MergeError';
  }
}

export class AuthError extends MediaBridgeError {
  constructor(message: string) {
    super(message, 'AUTH_ERROR');
    this.name = 'AuthError';
  }
}

export class UploadError extends MediaBridgeError {
  constructor(message: string, public statusCode?: number) {
    super(message, 'UPLOAD_ERROR');
    this.name = 'UploadError';
  }
}

