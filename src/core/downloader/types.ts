/**
 * Types for downloader modules
 */

import { DownloadState, VideoFormat } from "../types";

/**
 * Generic Result type for operations that can succeed or fail
 */
export type Result<T, E = Error> =
  | { ok: true; data: T }
  | { ok: false; error: E };

/**
 * Helper function to create a successful Result
 */
export function ok<T>(data: T): Result<T, never> {
  return { ok: true, data };
}

/**
 * Helper function to create a failed Result
 */
export function err<E>(error: E): Result<never, E> {
  return { ok: false, error };
}

/**
 * Result of format detection and validation
 */
export type FormatDetectionResult = Result<
  { format: VideoFormat; state: DownloadState },
  DownloadState
>;

/**
 * Result of download execution containing blob and extracted metadata
 */
export interface DownloadResult {
  blob: Blob;
  extractedMetadata: ExtractedMetadata;
}

/**
 * Metadata extracted from downloaded blob
 */
export interface ExtractedMetadata {
  fileExtension?: string;
}

/**
 * Progress callback for download handlers
 */
export type DownloadProgressCallback = (state: DownloadState) => void;

/**
 * Result from direct download operation (internal use)
 */
export interface DirectDownloadResult {
  filePath: string;
  totalBytes?: number;
}

/**
 * Options for DirectDownloadHandler
 */
export interface DirectDownloadHandlerOptions {
  onProgress?: DownloadProgressCallback;
}

/**
 * Result from DirectDownloadHandler download operation
 */
export interface DirectDownloadHandlerResult {
  filePath: string;
  fileExtension?: string;
}

