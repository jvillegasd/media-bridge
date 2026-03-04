/**
 * Cloud upload orchestration — Google Drive + S3.
 *
 * Designed to be called from the service worker BEFORE blob URL revocation
 * (i.e. inside the onBlobReady callback passed to saveBlobUrlToFile).
 */

import { GoogleDriveClient } from "./google-drive";
import { S3Client } from "./s3-client";
import { DownloadState, DownloadStage, StorageConfig } from "../types";
import { UploadError } from "../utils/errors";
import { logger } from "../utils/logger";

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

    return this.uploadBlob(blob, filename, downloadState);
  }

  /**
   * Upload an already-fetched blob to all configured providers.
   * Both Drive and S3 are attempted independently — one failing does not
   * prevent the other.
   */
  async uploadBlob(
    blob: Blob,
    filename: string,
    downloadState: DownloadState,
  ): Promise<CloudLinks> {
    const links: CloudLinks = {};

    // Notify UPLOADING stage
    downloadState.progress.stage = DownloadStage.UPLOADING;
    downloadState.progress.message = "Uploading to cloud...";
    downloadState.progress.percentage = 0;
    await this.onStateUpdate?.(downloadState);

    const totalBytes = blob.size;
    // Track combined progress from both providers (simple: use whichever fires)
    const onProgress = (uploaded: number, total: number) => {
      this.onProgress?.(uploaded, total);
    };

    // Run both providers concurrently; failures are independent
    const [driveResult, s3Result] = await Promise.allSettled([
      this.googleDrive
        ? this.uploadToDrive(blob, filename, onProgress)
        : Promise.resolve(null),
      this.s3
        ? this.s3.uploadBlob(blob, filename, onProgress)
        : Promise.resolve(null),
    ]);

    if (driveResult.status === "fulfilled" && driveResult.value) {
      links.googleDrive = driveResult.value.webViewLink ?? driveResult.value.fileId;
      logger.info(`Drive upload complete: ${links.googleDrive}`);
    } else if (driveResult.status === "rejected") {
      logger.error("Drive upload failed:", driveResult.reason);
    }

    if (s3Result.status === "fulfilled" && s3Result.value) {
      links.s3 = s3Result.value.url;
      logger.info(`S3 upload complete: ${links.s3}`);
    } else if (s3Result.status === "rejected") {
      logger.error("S3 upload failed:", s3Result.reason);
    }

    const bothFailed =
      driveResult.status === "rejected" && s3Result.status === "rejected";
    if (bothFailed) {
      const driveErr =
        driveResult.status === "rejected" ? String(driveResult.reason) : "";
      const s3Err = s3Result.status === "rejected" ? String(s3Result.reason) : "";
      throw new UploadError(`All uploads failed. Drive: ${driveErr} S3: ${s3Err}`);
    }

    return links;
  }

  private async uploadToDrive(
    blob: Blob,
    filename: string,
    onProgress: (uploaded: number, total: number) => void,
  ) {
    if (!this.googleDrive) return null;
    const result = await this.googleDrive.uploadFile(blob, filename);
    onProgress(blob.size, blob.size);
    return result;
  }

  isConfigured(): boolean {
    return this.googleDrive !== undefined || this.s3 !== undefined;
  }
}
