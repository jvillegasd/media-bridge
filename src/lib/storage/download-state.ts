/**
 * Download state management using Chrome Storage
 */

import { ChromeStorage } from './chrome-storage';
import { DownloadState, DownloadProgress } from '../types';
import { logger } from '../utils/logger';

const STORAGE_KEY_DOWNLOADS = 'downloads';
const STORAGE_KEY_DOWNLOAD_QUEUE = 'download_queue';

export class DownloadStateManager {
  /**
   * Get all download states
   */
  static async getAllDownloads(): Promise<DownloadState[]> {
    const downloads = await ChromeStorage.get<Record<string, DownloadState>>(STORAGE_KEY_DOWNLOADS);
    return downloads ? Object.values(downloads) : [];
  }

  /**
   * Get download state by ID
   */
  static async getDownload(id: string): Promise<DownloadState | null> {
    const downloads = await ChromeStorage.get<Record<string, DownloadState>>(STORAGE_KEY_DOWNLOADS);
    return downloads?.[id] ?? null;
  }

  /**
   * Get download state by URL
   */
  static async getDownloadByUrl(url: string): Promise<DownloadState | null> {
    const downloads = await this.getAllDownloads();
    return downloads.find(d => d.url === url) ?? null;
  }

  /**
   * Save or update download state
   */
  static async saveDownload(state: DownloadState): Promise<void> {
    try {
      const downloads = await ChromeStorage.get<Record<string, DownloadState>>(STORAGE_KEY_DOWNLOADS) || {};
      downloads[state.id] = {
        ...state,
        updatedAt: Date.now(),
      };
      await ChromeStorage.set(STORAGE_KEY_DOWNLOADS, downloads);
      logger.debug(`Saved download state for ${state.id}`);
    } catch (error) {
      logger.error(`Failed to save download state:`, error);
      throw error;
    }
  }

  /**
   * Update download progress
   */
  static async updateProgress(id: string, progress: Partial<DownloadProgress>): Promise<void> {
    const state = await this.getDownload(id);
    if (!state) {
      logger.warn(`Download ${id} not found for progress update`);
      return;
    }

    state.progress = {
      ...state.progress,
      ...progress,
    };
    await this.saveDownload(state);
  }

  /**
   * Remove download state
   */
  static async removeDownload(id: string): Promise<void> {
    try {
      const downloads = await ChromeStorage.get<Record<string, DownloadState>>(STORAGE_KEY_DOWNLOADS) || {};
      delete downloads[id];
      await ChromeStorage.set(STORAGE_KEY_DOWNLOADS, downloads);
      logger.debug(`Removed download state for ${id}`);
    } catch (error) {
      logger.error(`Failed to remove download state:`, error);
      throw error;
    }
  }

  /**
   * Clear all downloads
   */
  static async clearAll(): Promise<void> {
    await ChromeStorage.remove(STORAGE_KEY_DOWNLOADS);
    await ChromeStorage.remove(STORAGE_KEY_DOWNLOAD_QUEUE);
  }

  /**
   * Get download queue
   */
  static async getQueue(): Promise<string[]> {
    const queue = await ChromeStorage.get<string[]>(STORAGE_KEY_DOWNLOAD_QUEUE);
    return queue || [];
  }

  /**
   * Add to download queue
   */
  static async addToQueue(id: string): Promise<void> {
    const queue = await this.getQueue();
    if (!queue.includes(id)) {
      queue.push(id);
      await ChromeStorage.set(STORAGE_KEY_DOWNLOAD_QUEUE, queue);
    }
  }

  /**
   * Remove from download queue
   */
  static async removeFromQueue(id: string): Promise<void> {
    const queue = await this.getQueue();
    const filtered = queue.filter(qId => qId !== id);
    await ChromeStorage.set(STORAGE_KEY_DOWNLOAD_QUEUE, filtered);
  }
}

