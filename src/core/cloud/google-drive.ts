/**
 * Google Drive API client
 */

import { GoogleAuth, GOOGLE_DRIVE_SCOPES } from './google-auth';
import { UploadError } from '../utils/errors';
import { logger } from '../utils/logger';

const DRIVE_API_BASE = 'https://www.googleapis.com/drive/v3';

export interface GoogleDriveConfig {
  targetFolderId?: string;
  createFolderIfNotExists?: boolean;
  folderName?: string;
}

export interface UploadResult {
  fileId: string;
  webViewLink?: string;
}

export class GoogleDriveClient {
  private config: GoogleDriveConfig;

  constructor(config: GoogleDriveConfig = {}) {
    this.config = config;
  }

  /**
   * Upload file to Google Drive
   */
  async uploadFile(blob: Blob, filename: string): Promise<UploadResult> {
    try {
      const token = await GoogleAuth.getAccessToken(GOOGLE_DRIVE_SCOPES);
      
      // Ensure target folder exists
      let folderId = this.config.targetFolderId;
      if (!folderId && this.config.createFolderIfNotExists) {
        folderId = await this.createFolder(this.config.folderName || 'MediaBridge Uploads');
      }

      // For files larger than 5MB, use resumable upload
      if (blob.size > 5 * 1024 * 1024) {
        return await this.resumableUpload(blob, filename, token, folderId);
      }

      // Simple upload for smaller files
      return await this.simpleUpload(blob, filename, token, folderId);
    } catch (error) {
      logger.error('Google Drive upload failed:', error);
      throw error instanceof UploadError ? error : new UploadError(`Upload failed: ${error}`);
    }
  }

  /**
   * Simple upload (for files < 5MB)
   */
  private async simpleUpload(
    blob: Blob,
    filename: string,
    token: string,
    folderId?: string
  ): Promise<UploadResult> {
    const metadata: any = {
      name: filename,
    };

    if (folderId) {
      metadata.parents = [folderId];
    }

    const form = new FormData();
    form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
    form.append('file', blob);

    const response = await fetch(`${DRIVE_API_BASE}/files?uploadType=multipart`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
      },
      body: form,
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: { message: response.statusText } }));
      throw new UploadError(
        `Upload failed: ${error.error?.message || response.statusText}`,
        response.status
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
   * Resumable upload (for files > 5MB)
   */
  private async resumableUpload(
    blob: Blob,
    filename: string,
    token: string,
    folderId?: string
  ): Promise<UploadResult> {
    // Step 1: Initialize resumable upload session
    const metadata: any = {
      name: filename,
    };

    if (folderId) {
      metadata.parents = [folderId];
    }

    const initResponse = await fetch(`${DRIVE_API_BASE}/files?uploadType=resumable`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(metadata),
    });

    if (!initResponse.ok) {
      const error = await initResponse.json().catch(() => ({ error: { message: initResponse.statusText } }));
      throw new UploadError(
        `Failed to initialize upload: ${error.error?.message || initResponse.statusText}`,
        initResponse.status
      );
    }

    const uploadUrl = initResponse.headers.get('Location');
    if (!uploadUrl) {
      throw new UploadError('No upload URL received');
    }

    // Step 2: Upload file data
    const uploadResponse = await fetch(uploadUrl, {
      method: 'PUT',
      headers: {
        'Content-Type': blob.type || 'application/octet-stream',
        'Content-Length': blob.size.toString(),
      },
      body: blob,
    });

    if (!uploadResponse.ok) {
      throw new UploadError(
        `Upload failed: ${uploadResponse.statusText}`,
        uploadResponse.status
      );
    }

    const result = await uploadResponse.json();
    
    logger.info(`File uploaded successfully (resumable): ${result.id}`);
    
    return {
      fileId: result.id,
      webViewLink: result.webViewLink,
    };
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
        mimeType: 'application/vnd.google-apps.folder',
      };

      const response = await fetch(`${DRIVE_API_BASE}/files`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(metadata),
      });

      if (!response.ok) {
        const error = await response.json().catch(() => ({ error: { message: response.statusText } }));
        throw new UploadError(
          `Failed to create folder: ${error.error?.message || response.statusText}`,
          response.status
        );
      }

      const result = await response.json();
      logger.info(`Folder created: ${result.id}`);
      
      return result.id;
    } catch (error) {
      logger.error('Failed to create folder:', error);
      throw error instanceof UploadError ? error : new UploadError(`Failed to create folder: ${error}`);
    }
  }

  /**
   * Find folder by name
   */
  private async findFolder(folderName: string, token: string): Promise<string | null> {
    try {
      const query = encodeURIComponent(
        `mimeType='application/vnd.google-apps.folder' and name='${folderName}' and trashed=false`
      );

      const response = await fetch(`${DRIVE_API_BASE}/files?q=${query}&fields=files(id,name)`, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${token}`,
        },
      });

      if (!response.ok) {
        return null;
      }

      const result = await response.json();
      if (result.files && result.files.length > 0) {
        return result.files[0].id;
      }

      return null;
    } catch (error) {
      logger.warn('Failed to find folder:', error);
      return null;
    }
  }

  /**
   * Get file info
   */
  async getFileInfo(fileId: string): Promise<any> {
    try {
      const token = await GoogleAuth.getAccessToken(GOOGLE_DRIVE_SCOPES);

      const response = await fetch(`${DRIVE_API_BASE}/files/${fileId}?fields=id,name,webViewLink,size`, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${token}`,
        },
      });

      if (!response.ok) {
        throw new UploadError(`Failed to get file info: ${response.statusText}`, response.status);
      }

      return await response.json();
    } catch (error) {
      logger.error('Failed to get file info:', error);
      throw error instanceof UploadError ? error : new UploadError(`Failed to get file info: ${error}`);
    }
  }
}

