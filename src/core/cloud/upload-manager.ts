/**
 * Cloud upload orchestration — Google Drive + S3.
 */

import { GoogleDriveClient } from "./google-drive";
import { S3Client } from "./s3-client";
import { DownloadState, DownloadStage, StorageConfig } from "../types";
import { UploadError } from "../utils/errors";
import { logger } from "../utils/logger";
import { CloudProvider } from "../../shared/messages";

export interface CloudLinks {
  googleDrive?: string; // webViewLink
  s3?: string;          // object URL
}

export interface UploadManagerOptions {
  config: StorageConfig;
  onProgress?: (uploadedBytes: number, totalBytes: number) => void;
  onStateUpdate?: (state: DownloadState) => Promise<void>;
}

export class UploadManager {
  private readonly googleDrive?: GoogleDriveClient;
  private readonly s3?: S3Client;
  private readonly onProgress?: (uploaded: number, total: number) => void;
  private readonly onStateUpdate?: (state: DownloadState) => Promise<void>;

  constructor(options: UploadManagerOptions) {
    const { config } = options;
    this.onProgress = options.onProgress;
    this.onStateUpdate = options.onStateUpdate;

    if (config.googleDrive?.enabled) {
      this.googleDrive = new GoogleDriveClient({
        targetFolderId: config.googleDrive.targetFolderId,
        createFolderIfNotExists: config.googleDrive.createFolderIfNotExists,
        folderName: config.googleDrive.folderName,
      });
    }

    if (
      config.s3?.enabled &&
      config.s3.bucket &&
      config.s3.region &&
      config.s3.accessKeyId &&
      config.s3.secretAccessKey
    ) {
      this.s3 = new S3Client({
        bucket: config.s3.bucket,
        region: config.s3.region,
        accessKeyId: config.s3.accessKeyId,
        secretAccessKey: config.s3.secretAccessKey,
        endpoint: config.s3.endpoint,
        prefix: config.s3.prefix,
      });
    }
  }

  /**
   * Fetch the blob from a blob URL and upload to all configured providers.
   * This must be called BEFORE the blob URL is revoked.
   *
   * Updates downloadState.progress.stage to UPLOADING and writes progress
   * via onStateUpdate during the upload.
   */
  async uploadFromBlobUrl(
    blobUrl: string,
    filename: string,
    downloadState: DownloadState,
    provider: CloudProvider,
  ): Promise<CloudLinks> {
    if (!this.isConfigured()) {
      return {};
    }

    // Fetch the blob while it's still alive
    const response = await fetch(blobUrl);
    if (!response.ok) {
      throw new UploadError(`Failed to read blob for upload: ${response.statusText}`);
    }
    const blob = await response.blob();

    return this.uploadBlob(blob, filename, downloadState, provider);
  }

  /**
   * Upload an already-fetched blob to a single chosen provider.
   */
  async uploadBlob(
    blob: Blob,
    filename: string,
    downloadState: DownloadState,
    provider: CloudProvider,
  ): Promise<CloudLinks> {
    const links: CloudLinks = {};

    // Notify UPLOADING stage
    downloadState.progress.stage = DownloadStage.UPLOADING;
    downloadState.progress.message = "Uploading to cloud...";
    downloadState.progress.percentage = 0;
    await this.onStateUpdate?.(downloadState);

    const onProgress = (uploaded: number, total: number) => {
      this.onProgress?.(uploaded, total);
    };

    if (provider === 'googleDrive') {
      if (!this.googleDrive) {
        throw new UploadError('Google Drive is not configured');
      }
      const result = await this.uploadToDrive(blob, filename, onProgress);
      if (result) {
        links.googleDrive = result.webViewLink ?? result.fileId;
        logger.info(`Drive upload complete: ${links.googleDrive}`);
      }
    } else {
      if (!this.s3) {
        throw new UploadError('S3 is not configured');
      }
      const result = await this.s3.uploadBlob(blob, filename, onProgress);
      if (result) {
        links.s3 = result.url;
        logger.info(`S3 upload complete: ${links.s3}`);
      }
    }

    return links;
  }

  private async uploadToDrive(
    blob: Blob,
    filename: string,
    onProgress: (uploaded: number, total: number) => void,
  ) {
    if (!this.googleDrive) return null;
    return this.googleDrive.uploadFile(blob, filename, onProgress);
  }

  isConfigured(): boolean {
    return this.googleDrive !== undefined || this.s3 !== undefined;
  }
}
