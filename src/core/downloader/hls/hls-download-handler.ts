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

      // Step 2: Select video and audio levels
      const videoLevel = selectedLevel || this.selectBestLevel(levels);
      const audioLevel = this.selectBestAudioLevel(levels);
      logger.info(`Selected video level: ${videoLevel.uri}`);
      if (audioLevel) {
        logger.info(`Selected audio level: ${audioLevel.uri}`);
      }

      // Step 3: Fetch and parse video playlist
      await this.updateProgress(stateId, 'downloading', 0.1, 'Fetching video playlist...');
      const videoPlaylistText = await HlsLoader.fetchText(videoLevel.uri, this.fetchAttempts);
      const videoFragments = HlsParser.parseLevelPlaylist(videoPlaylistText, videoLevel.uri);

      if (videoFragments.length === 0) {
        throw new Error('No video fragments found in playlist');
      }

      logger.info(`Found ${videoFragments.length} video fragments`);

      // Step 3b: Fetch and parse audio playlist if available
      let audioFragments: HlsFragment[] = [];
      if (audioLevel) {
        try {
          await this.updateProgress(stateId, 'downloading', 0.12, 'Fetching audio playlist...');
          const audioPlaylistText = await HlsLoader.fetchText(audioLevel.uri, this.fetchAttempts);
          audioFragments = HlsParser.parseLevelPlaylist(audioPlaylistText, audioLevel.uri);
          logger.info(`Found ${audioFragments.length} audio fragments`);
        } catch (error) {
          logger.warn('Failed to fetch audio playlist, continuing with video only:', error);
          // Continue without audio - some streams might be muxed
        }
      }

      // Step 4: Create storage bucket
      await this.updateProgress(stateId, 'downloading', 0.15, 'Initializing storage...');
      const bucket = await hlsStorageManager.createBucket(
        stateId,
        videoFragments.length,
        audioFragments.length
      );

      try {
        // Step 5: Download all fragments concurrently
        const totalFragments = videoFragments.length + audioFragments.length;
        await this.updateProgress(
          stateId,
          'downloading',
          0.2,
          `Downloading ${totalFragments} segments...`
        );
        
        // Download video fragments
        await this.downloadFragments(videoFragments, bucket, stateId, 0, videoFragments.length);
        
        // Download audio fragments if available
        if (audioFragments.length > 0) {
          await this.downloadFragments(audioFragments, bucket, stateId, videoFragments.length, audioFragments.length);
        }

        // Step 6: Merge segments
        await this.updateProgress(stateId, 'merging', 0.9, 'Merging segments...');
        const linkOrBlob = await bucket.getLink((progress, message) => {
          this.updateProgress(stateId, 'merging', 0.9 + progress * 0.1, message).catch(
            logger.error
          );
        });

        // Step 7: Get the merged blob
        let blob: Blob;
        if (linkOrBlob instanceof Blob) {
          // Service worker context - blob returned directly
          blob = linkOrBlob;
        } else {
          // Regular context - fetch from blob URL
          const response = await fetch(linkOrBlob);
          blob = await response.blob();
          // Only revoke if URL.revokeObjectURL is available (not in service worker)
          if (typeof URL !== 'undefined' && typeof URL.revokeObjectURL === 'function') {
            try {
              URL.revokeObjectURL(linkOrBlob);
            } catch (error) {
              // Ignore errors if revoke fails
              logger.debug('Could not revoke blob URL:', error);
            }
          }
        }

        // Cleanup
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
   * Select the best audio level (highest bitrate)
   */
  private selectBestAudioLevel(levels: HlsLevel[]): HlsLevel | null {
    const audioLevels = levels.filter((l) => l.type === 'audio');
    if (audioLevels.length === 0) {
      return null;
    }

    // Sort by bitrate (descending) and select highest
    // If no bitrate info, just return the first one
    return audioLevels.sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0))[0];
  }

  /**
   * Download all fragments with concurrency control
   */
  private async downloadFragments(
    fragments: HlsFragment[],
    bucket: IndexedDBHlsBucket,
    stateId: string,
    startIndex: number = 0,
    totalCount?: number
  ): Promise<void> {
    const total = totalCount || fragments.length;
    let downloaded = 0;
    const startTime = Date.now();

    // Download fragments with concurrency limit
    const downloadPromises: Promise<void>[] = [];
    const semaphore = new Array(this.maxConcurrency).fill(null);

    for (let i = 0; i < fragments.length; i++) {
      const fragment = fragments[i];
      const index = startIndex + i;

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

          // Write to bucket with adjusted index
          await bucket.write(index, segmentData);

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

