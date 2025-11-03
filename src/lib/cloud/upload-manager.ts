/**
 * Cloud upload orchestration
 */

import { GoogleDriveClient, UploadResult } from './google-drive';
import { DownloadState } from '../types';
import { UploadError } from '../utils/errors';
import { logger } from '../utils/logger';
import { StorageConfig } from '../types';

export interface UploadManagerOptions {
  config?: StorageConfig;
  onProgress?: (state: DownloadState) => void;
}

export class UploadManager {
  private googleDrive?: GoogleDriveClient;
  private onProgress?: (state: DownloadState) => void;

  constructor(options: UploadManagerOptions = {}) {
    if (options.config?.googleDrive?.enabled) {
      this.googleDrive = new GoogleDriveClient({
        targetFolderId: options.config.googleDrive.targetFolderId,
        createFolderIfNotExists: options.config.googleDrive.createFolderIfNotExists,
        folderName: options.config.googleDrive.folderName,
      });
    }

    this.onProgress = options.onProgress;
  }

  /**
   * Upload file to configured cloud storage
   */
  async uploadFile(
    blob: Blob,
    filename: string,
    downloadState?: DownloadState
  ): Promise<UploadResult | null> {
    if (!this.googleDrive) {
      logger.warn('Google Drive not configured');
      return null;
    }

    try {
      if (downloadState) {
        downloadState.progress.stage = 'uploading';
        downloadState.progress.message = 'Uploading to Google Drive...';
        this.onProgress?.(downloadState);
      }

      const result = await this.googleDrive.uploadFile(blob, filename);

      if (downloadState) {
        downloadState.cloudId = result.fileId;
        downloadState.progress.stage = 'completed';
        downloadState.progress.message = 'Upload completed';
        this.onProgress?.(downloadState);
      }

      logger.info(`File uploaded successfully: ${result.fileId}`);
      return result;
    } catch (error) {
      logger.error('Upload failed:', error);

      if (downloadState) {
        downloadState.progress.stage = 'failed';
        downloadState.progress.error = error instanceof Error ? error.message : String(error);
        this.onProgress?.(downloadState);
      }

      throw error instanceof UploadError ? error : new UploadError(`Upload failed: ${error}`);
    }
  }

  /**
   * Check if upload is configured
   */
  isConfigured(): boolean {
    return this.googleDrive !== undefined;
  }
}

