/**
 * HLS download handler - orchestrates HLS downloads
 */

import { HlsParser, HlsFragment, HlsLevel } from './hls-parser';
import { HlsLoader } from './hls-loader';
import { HlsDecryptor } from './hls-decryptor';
import { hlsStorageManager, IndexedDBHlsBucket } from './hls-storage';
import { DownloadStateManager } from '../../storage/download-state';
import { DownloadState } from '../../types';
import { logger } from '../../utils/logger';

export interface HlsDownloadHandlerOptions {
  onProgress?: (state: DownloadState) => void;
  maxConcurrency?: number;
  fetchAttempts?: number;
}

export class HlsDownloadHandler {
  private onProgress?: (state: DownloadState) => void;
  private maxConcurrency: number;
  private fetchAttempts: number;

  constructor(options: HlsDownloadHandlerOptions = {}) {
    this.onProgress = options.onProgress;
    this.maxConcurrency = options.maxConcurrency || 5;
    this.fetchAttempts = options.fetchAttempts || 3;
  }

  /**
   * Download HLS video
   */
  async download(
    playlistUrl: string,
    stateId: string,
    selectedLevel?: HlsLevel
  ): Promise<Blob> {
    try {
      logger.info(`Starting HLS download from ${playlistUrl}`);

      // Step 1: Fetch and parse master playlist
      await this.updateProgress(stateId, 'downloading', 0.05, 'Fetching master playlist...');
      const masterPlaylistText = await HlsLoader.fetchText(playlistUrl, this.fetchAttempts);
      const levels = HlsParser.parseMasterPlaylist(masterPlaylistText, playlistUrl);

      if (levels.length === 0) {
        throw new Error('No video levels found in master playlist');
      }

      // Step 2: Select level (use provided or highest quality)
      const level = selectedLevel || this.selectBestLevel(levels);
      logger.info(`Selected level: ${level.uri}`);

      // Step 3: Fetch and parse level playlist
      await this.updateProgress(stateId, 'downloading', 0.1, 'Fetching level playlist...');
      const levelPlaylistText = await HlsLoader.fetchText(level.uri, this.fetchAttempts);
      const fragments = HlsParser.parseLevelPlaylist(levelPlaylistText, level.uri);

      if (fragments.length === 0) {
        throw new Error('No fragments found in level playlist');
      }

      logger.info(`Found ${fragments.length} fragments`);

      // Step 4: Create storage bucket
      await this.updateProgress(stateId, 'downloading', 0.15, 'Initializing storage...');
      const videoFragments = fragments; // For now, assume all are video
      const audioFragments: HlsFragment[] = []; // TODO: Handle separate audio tracks
      const bucket = await hlsStorageManager.createBucket(
        stateId,
        videoFragments.length,
        audioFragments.length
      );

      try {
        // Step 5: Download all fragments concurrently
        await this.updateProgress(
          stateId,
          'downloading',
          0.2,
          `Downloading ${fragments.length} segments...`
        );
        await this.downloadFragments(fragments, bucket, stateId);

        // Step 6: Merge segments
        await this.updateProgress(stateId, 'merging', 0.9, 'Merging segments...');
        const blobUrl = await bucket.getLink((progress, message) => {
          this.updateProgress(stateId, 'merging', 0.9 + progress * 0.1, message).catch(
            logger.error
          );
        });

        // Step 7: Fetch the merged blob
        const response = await fetch(blobUrl);
        const blob = await response.blob();

        // Cleanup
        URL.revokeObjectURL(blobUrl);
        await bucket.cleanup();

        logger.info('HLS download completed successfully');
        return blob;
      } catch (error) {
        // Cleanup on error
        await bucket.cleanup().catch(logger.error);
        throw error;
      }
    } catch (error) {
      logger.error('HLS download failed:', error);
      throw error;
    }
  }

  /**
   * Select the best quality level (highest bitrate)
   */
  private selectBestLevel(levels: HlsLevel[]): HlsLevel {
    const videoLevels = levels.filter((l) => l.type === 'stream');
    if (videoLevels.length === 0) {
      return levels[0];
    }

    // Sort by bitrate (descending) and select highest
    return videoLevels.sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0))[0];
  }

  /**
   * Download all fragments with concurrency control
   */
  private async downloadFragments(
    fragments: HlsFragment[],
    bucket: IndexedDBHlsBucket,
    stateId: string
  ): Promise<void> {
    const total = fragments.length;
    let downloaded = 0;
    const startTime = Date.now();

    // Download fragments with concurrency limit
    const downloadPromises: Promise<void>[] = [];
    const semaphore = new Array(this.maxConcurrency).fill(null);

    for (let i = 0; i < fragments.length; i++) {
      const fragment = fragments[i];
      const index = i;

      // Wait for a slot to be available
      const slot = await Promise.race(
        semaphore.map((_, idx) =>
          Promise.resolve(idx).then(async (idx) => {
            while (semaphore[idx] !== null) {
              await new Promise((resolve) => setTimeout(resolve, 10));
            }
            return idx;
          })
        )
      );

      // Download fragment
      const promise = (async () => {
        try {
          semaphore[slot] = fragment;

          // Fetch and decrypt if needed
          const segmentData = await HlsDecryptor.fetchAndDecrypt(
            fragment.uri,
            fragment.key,
            this.fetchAttempts
          );

          // Write to bucket
          await bucket.write(fragment.index, segmentData);

          downloaded++;
          const percentage = (downloaded / total) * 100;
          const elapsed = (Date.now() - startTime) / 1000;
          const speed = downloaded > 0 ? (downloaded / elapsed) * total : 0;

          await this.updateProgress(
            stateId,
            'downloading',
            0.2 + (downloaded / total) * 0.7,
            `Downloaded ${downloaded}/${total} segments (${percentage.toFixed(1)}%)`
          );

          logger.debug(`Downloaded fragment ${index + 1}/${total}`);
        } catch (error) {
          logger.error(`Failed to download fragment ${index}:`, error);
          throw error;
        } finally {
          semaphore[slot] = null;
        }
      })();

      downloadPromises.push(promise);
    }

    // Wait for all downloads to complete
    await Promise.all(downloadPromises);
  }

  /**
   * Update download progress
   */
  private async updateProgress(
    stateId: string,
    stage: DownloadState['progress']['stage'],
    percentage: number,
    message?: string
  ): Promise<void> {
    const state = await DownloadStateManager.getDownload(stateId);
    if (state) {
      state.progress.stage = stage;
      state.progress.percentage = percentage;
      if (message) {
        state.progress.message = message;
      }
      state.updatedAt = Date.now();
      await DownloadStateManager.saveDownload(state);
      this.notifyProgress(state);
    }
  }

  /**
   * Notify progress
   */
  private notifyProgress(state: DownloadState): void {
    if (this.onProgress) {
      this.onProgress(state);
    }
  }
}

