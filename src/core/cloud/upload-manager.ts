/**
 * Cloud upload orchestration — provider-agnostic registry.
 */

import { GoogleDriveClient } from "./google-drive";
import { S3Client } from "./s3-client";
import { BaseCloudProvider, ProgressCallback } from "./base-cloud-provider";
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
  private readonly providers = new Map<CloudProvider, BaseCloudProvider>();
  private readonly onProgress?: (uploaded: number, total: number) => void;
  private readonly onStateUpdate?: (state: DownloadState) => Promise<void>;

  constructor(options: UploadManagerOptions) {
    const { config } = options;
    this.onProgress = options.onProgress;
    this.onStateUpdate = options.onStateUpdate;

    if (config.googleDrive?.enabled) {
      const drive = new GoogleDriveClient({
        targetFolderId: config.googleDrive.targetFolderId,
        createFolderIfNotExists: config.googleDrive.createFolderIfNotExists,
        folderName: config.googleDrive.folderName,
      });
      this.providers.set(drive.id, drive);
    }

    if (
      config.s3?.enabled &&
      config.s3.bucket &&
      config.s3.region &&
      config.s3.accessKeyId &&
      config.s3.secretAccessKey
    ) {
      const s3 = new S3Client({
        bucket: config.s3.bucket,
        region: config.s3.region,
        accessKeyId: config.s3.accessKeyId,
        secretAccessKey: config.s3.secretAccessKey,
        endpoint: config.s3.endpoint,
        prefix: config.s3.prefix,
      });
      this.providers.set(s3.id, s3);
    }
  }

  /**
   * Fetch the blob from a blob URL and upload to the chosen provider.
   * Must be called BEFORE the blob URL is revoked.
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
    signal?: AbortSignal,
  ): Promise<CloudLinks> {
    const client = this.providers.get(provider);
    if (!client) {
      throw new UploadError(`Provider "${provider}" is not configured`);
    }

    // Notify UPLOADING stage
    downloadState.progress.stage = DownloadStage.UPLOADING;
    downloadState.progress.message = "Uploading to cloud...";
    downloadState.progress.percentage = 0;
    await this.onStateUpdate?.(downloadState);

    const onProgress: ProgressCallback = (uploaded, total) => {
      this.onProgress?.(uploaded, total);
      const pct = total > 0 ? Math.round((uploaded / total) * 100) : 0;
      if (downloadState.progress.percentage !== pct) {
        downloadState.progress.percentage = pct;
        downloadState.progress.message = `Uploading... ${pct}%`;
        // Fire-and-forget — don't block the upload data flow
        this.onStateUpdate?.(downloadState);
      }
    };
    const url = await client.upload(blob, filename, onProgress, signal);

    const links: CloudLinks = {};
    links[provider] = url;
    logger.info(`${provider} upload complete: ${url}`);

    return links;
  }

  isConfigured(): boolean {
    return this.providers.size > 0;
  }
}
