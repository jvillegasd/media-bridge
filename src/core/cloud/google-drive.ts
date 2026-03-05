/**
 * Google Drive API client
 */

import { GoogleAuth, GOOGLE_DRIVE_SCOPES } from "./google-auth";
import { BaseCloudProvider, ProgressCallback } from "./base-cloud-provider";
import { UploadError } from "../utils/errors";
import { logger } from "../utils/logger";

const DRIVE_API_BASE = "https://www.googleapis.com/drive/v3";
const DRIVE_UPLOAD_BASE = "https://www.googleapis.com/upload/drive/v3";
const RESUMABLE_UPLOAD_THRESHOLD_BYTES = 5 * 1024 * 1024; // 5 MB
const CHUNK_SIZE = 8 * 1024 * 1024; // 8 MB — must be a multiple of 256 KB

export interface GoogleDriveConfig {
  targetFolderId?: string;
  createFolderIfNotExists?: boolean;
  folderName?: string;
}

export interface UploadResult {
  fileId: string;
  webViewLink?: string;
}

export class GoogleDriveClient extends BaseCloudProvider {
  readonly id = 'googleDrive' as const;
  private config: GoogleDriveConfig;

  constructor(config: GoogleDriveConfig = {}) {
    super();
    this.config = config;
  }

  /**
   * Upload file to Google Drive. Returns the webViewLink (or fileId as fallback).
   */
  async upload(
    blob: Blob,
    filename: string,
    onProgress?: ProgressCallback,
    signal?: AbortSignal,
  ): Promise<string> {
    try {
      const token = await GoogleAuth.getAccessToken(GOOGLE_DRIVE_SCOPES);

      // Ensure target folder exists
      let folderId = this.config.targetFolderId;
      if (!folderId && this.config.createFolderIfNotExists) {
        folderId = await this.createFolder(
          this.config.folderName || "MediaBridge Uploads",
        );
      }

      // For files larger than 5MB, use resumable chunked upload
      let result: UploadResult;
      if (blob.size > RESUMABLE_UPLOAD_THRESHOLD_BYTES) {
        result = await this.resumableUpload(blob, filename, token, folderId, onProgress, signal);
      } else {
        // Simple multipart upload for smaller files
        result = await this.simpleUpload(blob, filename, token, folderId, signal);
      }

      return result.webViewLink ?? result.fileId;
    } catch (error) {
      logger.error("Google Drive upload failed:", error);
      throw error instanceof UploadError
        ? error
        : new UploadError(`Upload failed: ${error}`);
    }
  }

  /**
   * Simple upload (for files < 5MB)
   */
  private async simpleUpload(
    blob: Blob,
    filename: string,
    token: string,
    folderId?: string,
    signal?: AbortSignal,
  ): Promise<UploadResult> {
    const metadata: any = {
      name: filename,
    };

    if (folderId) {
      metadata.parents = [folderId];
    }

    const form = new FormData();
    form.append(
      "metadata",
      new Blob([JSON.stringify(metadata)], { type: "application/json" }),
    );
    form.append("file", blob);

    const response = await fetch(
      `${DRIVE_API_BASE}/files?uploadType=multipart`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
        },
        body: form,
        signal,
      },
    );

    if (!response.ok) {
      const error = await response
        .json()
        .catch(() => ({ error: { message: response.statusText } }));
      throw new UploadError(
        `Upload failed: ${error.error?.message || response.statusText}`,
        response.status,
      );
    }

    const result = await response.json();

    logger.info(`File uploaded successfully: ${result.id}`);

    return {
      fileId: result.id,
      webViewLink: result.webViewLink,
    };
  }

  /**
   * Resumable chunked upload (for files > 5 MB).
   *
   * Protocol:
   *  1. POST to initiate session → get Location (session URI)
   *  2. PUT chunks in CHUNK_SIZE increments with Content-Range header
   *     - Intermediate chunks → 308 Resume Incomplete; read Range header for offset
   *     - Final chunk → 200 OK / 201 Created with file metadata
   */
  private async resumableUpload(
    blob: Blob,
    filename: string,
    token: string,
    folderId?: string,
    onProgress?: ProgressCallback,
    signal?: AbortSignal,
  ): Promise<UploadResult> {
    const totalBytes = blob.size;
    const mimeType = blob.type || "application/octet-stream";

    // Step 1: Initiate resumable session
    const metadata: Record<string, unknown> = { name: filename };
    if (folderId) metadata.parents = [folderId];

    const initResponse = await fetch(
      `${DRIVE_UPLOAD_BASE}/files?uploadType=resumable`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json; charset=UTF-8",
          "X-Upload-Content-Type": mimeType,
          "X-Upload-Content-Length": totalBytes.toString(),
        },
        body: JSON.stringify(metadata),
      },
    );

    if (!initResponse.ok) {
      const err = await initResponse
        .json()
        .catch(() => ({ error: { message: initResponse.statusText } }));
      throw new UploadError(
        `Failed to initialize resumable upload: ${err.error?.message || initResponse.statusText}`,
        initResponse.status,
      );
    }

    const sessionUri = initResponse.headers.get("Location");
    if (!sessionUri) {
      throw new UploadError("Drive did not return a resumable session URI");
    }

    // Step 2: Upload chunks
    let offset = 0;

    while (offset < totalBytes) {
      signal?.throwIfAborted();
      const end = Math.min(offset + CHUNK_SIZE, totalBytes);
      const chunk = blob.slice(offset, end);
      const chunkSize = end - offset;
      const isLast = end === totalBytes;

      const response = await fetch(sessionUri, {
        method: "PUT",
        headers: {
          "Content-Length": chunkSize.toString(),
          "Content-Range": `bytes ${offset}-${end - 1}/${totalBytes}`,
          "Content-Type": mimeType,
        },
        body: chunk,
        signal,
      });

      // Session expired — cannot recover without restarting
      if (response.status === 404) {
        throw new UploadError("Resumable upload session expired (404)");
      }

      // 5xx errors: could query server position and retry, but keep it simple
      if (response.status >= 500) {
        throw new UploadError(
          `Server error during chunk upload: ${response.status} ${response.statusText}`,
          response.status,
        );
      }

      if (isLast) {
        // Final chunk: expect 200 or 201
        if (response.status !== 200 && response.status !== 201) {
          throw new UploadError(
            `Unexpected status for final chunk: ${response.status}`,
            response.status,
          );
        }
        const result = await response.json();
        logger.info(`Drive upload complete (resumable): ${result.id}`);
        onProgress?.(totalBytes, totalBytes);
        return { fileId: result.id, webViewLink: result.webViewLink };
      }

      // Intermediate chunk: expect 308 Resume Incomplete
      if (response.status !== 308) {
        throw new UploadError(
          `Unexpected status for intermediate chunk: ${response.status}`,
          response.status,
        );
      }

      // Advance offset from server-confirmed Range header
      const rangeHeader = response.headers.get("Range");
      if (rangeHeader) {
        // Format: "bytes=0-N"
        const confirmedEnd = parseInt(rangeHeader.split("-")[1], 10);
        offset = confirmedEnd + 1;
      } else {
        // Server received nothing yet — retry from same offset
        logger.warn("Drive returned 308 with no Range header; retrying chunk from same offset");
      }

      onProgress?.(offset, totalBytes);
    }

    // Should be unreachable
    throw new UploadError("Resumable upload loop exited without completing");
  }

  /**
   * Create folder in Google Drive
   */
  async createFolder(folderName: string): Promise<string> {
    try {
      const token = await GoogleAuth.getAccessToken(GOOGLE_DRIVE_SCOPES);

      // Check if folder already exists
      const existingFolder = await this.findFolder(folderName, token);
      if (existingFolder) {
        logger.info(`Folder already exists: ${existingFolder}`);
        return existingFolder;
      }

      // Create new folder
      const metadata = {
        name: folderName,
        mimeType: "application/vnd.google-apps.folder",
      };

      const response = await fetch(`${DRIVE_API_BASE}/files`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(metadata),
      });

      if (!response.ok) {
        const error = await response
          .json()
          .catch(() => ({ error: { message: response.statusText } }));
        throw new UploadError(
          `Failed to create folder: ${
            error.error?.message || response.statusText
          }`,
          response.status,
        );
      }

      const result = await response.json();
      logger.info(`Folder created: ${result.id}`);

      return result.id;
    } catch (error) {
      logger.error("Failed to create folder:", error);
      throw error instanceof UploadError
        ? error
        : new UploadError(`Failed to create folder: ${error}`);
    }
  }

  /**
   * Find folder by name
   */
  private async findFolder(
    folderName: string,
    token: string,
  ): Promise<string | null> {
    try {
      const query = encodeURIComponent(
        `mimeType='application/vnd.google-apps.folder' and name='${folderName}' and trashed=false`,
      );

      const response = await fetch(
        `${DRIVE_API_BASE}/files?q=${query}&fields=files(id,name)`,
        {
          method: "GET",
          headers: {
            Authorization: `Bearer ${token}`,
          },
        },
      );

      if (!response.ok) {
        return null;
      }

      const result = await response.json();
      if (result.files && result.files.length > 0) {
        return result.files[0].id;
      }

      return null;
    } catch (error) {
      logger.warn("Failed to find folder:", error);
      return null;
    }
  }

  /**
   * Get file info
   */
  async getFileInfo(fileId: string): Promise<any> {
    try {
      const token = await GoogleAuth.getAccessToken(GOOGLE_DRIVE_SCOPES);

      const response = await fetch(
        `${DRIVE_API_BASE}/files/${fileId}?fields=id,name,webViewLink,size`,
        {
          method: "GET",
          headers: {
            Authorization: `Bearer ${token}`,
          },
        },
      );

      if (!response.ok) {
        throw new UploadError(
          `Failed to get file info: ${response.statusText}`,
          response.status,
        );
      }

      return await response.json();
    } catch (error) {
      logger.error("Failed to get file info:", error);
      throw error instanceof UploadError
        ? error
        : new UploadError(`Failed to get file info: ${error}`);
    }
  }
}
