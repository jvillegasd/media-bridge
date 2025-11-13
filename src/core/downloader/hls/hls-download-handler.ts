/**
 * HLS download handler - orchestrates HLS video downloads
 * Downloads fragments, decrypts if needed, stores in IndexedDB, and concatenates
 */

import { DownloadError } from "../../utils/errors";
import { DownloadStateManager } from "../../storage/download-state";
import { DownloadState, Fragment, Level } from "../../types";
import { logger } from "../../utils/logger";
import { decrypt } from "../../utils/crypto-utils";
import { fetchText, fetchArrayBuffer } from "../../utils/fetch-utils";
import { parseMasterPlaylist, parseLevelsPlaylist } from "../../utils/m3u8-parser";
import { storeChunk, deleteChunks } from "../../storage/indexeddb-chunks";
import { createOffscreenDocument } from "../../utils/offscreen-manager";
import { MessageType } from "../../../shared/messages";
import {
  DownloadProgressCallback,
  DownloadProgressCallback as ProgressCallback,
} from "../types";

export interface HlsDownloadHandlerOptions {
  onProgress?: DownloadProgressCallback;
  maxConcurrent?: number;
}

interface Key {
  iv: string | null;
  uri: string | null;
}

/**
 * Decrypt a single fragment if it's encrypted
 * Based on the guidance provided by the user
 */
async function decryptSingleFragment(
  key: Key,
  data: ArrayBuffer,
  fetchAttempts: number = 3,
): Promise<ArrayBuffer> {
  // If no key URI or IV, fragment is not encrypted
  if (!key.uri || !key.iv) {
    return data;
  }

  try {
    // Fetch the encryption key
    const keyArrayBuffer = await fetchArrayBuffer(key.uri, fetchAttempts);

    // Convert IV from hex string to Uint8Array
    // IV should be 16 bytes for AES-128
    const hexString = key.iv.startsWith('0x') ? key.iv.slice(2) : key.iv;
    const ivBytes = new Uint8Array(16);
    
    // Parse hex string (should be 32 hex chars = 16 bytes)
    // Pad or truncate to exactly 16 bytes
    const normalizedHex = hexString.padEnd(32, '0').slice(0, 32);
    for (let i = 0; i < 16; i++) {
      const hexByte = normalizedHex.substring(i * 2, i * 2 + 2);
      ivBytes[i] = parseInt(hexByte, 16);
    }

    // Decrypt the data
    const decryptedData = await decrypt(data, keyArrayBuffer, ivBytes);
    return decryptedData;
  } catch (error) {
    logger.error(`Failed to decrypt fragment:`, error);
    throw new Error(`Decryption failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export class HlsDownloadHandler {
  private readonly onProgress?: ProgressCallback;
  private readonly maxConcurrent: number;
  private videoLength: number = 0;
  private audioLength: number = 0;
  private downloadId: string = "";
  private bytesDownloaded: number = 0;
  private totalBytes: number = 0;
  private lastUpdateTime: number = 0;
  private lastDownloadedBytes: number = 0;

  constructor(options: HlsDownloadHandlerOptions = {}) {
    this.onProgress = options.onProgress;
    this.maxConcurrent = options.maxConcurrent || 3;
  }

  /**
   * Update download progress with bytes and speed calculation
   */
  private async updateProgress(
    stateId: string,
    downloadedBytes: number,
    totalBytes: number,
    message?: string,
  ): Promise<void> {
    const state = await DownloadStateManager.getDownload(stateId);
    if (!state) {
      return;
    }

    const now = Date.now();
    let speed = 0;

    // Calculate speed if we have previous data
    if (this.lastUpdateTime > 0 && this.lastDownloadedBytes > 0) {
      const timeDelta = (now - this.lastUpdateTime) / 1000; // Convert to seconds
      const bytesDelta = downloadedBytes - this.lastDownloadedBytes;
      
      if (timeDelta > 0) {
        speed = bytesDelta / timeDelta; // bytes per second
      }
    }

    // Update tracking variables
    this.lastUpdateTime = now;
    this.lastDownloadedBytes = downloadedBytes;
    this.bytesDownloaded = downloadedBytes;
    this.totalBytes = totalBytes;

    const percentage = totalBytes > 0 ? (downloadedBytes / totalBytes) * 100 : 0;
    state.progress.downloaded = downloadedBytes;
    state.progress.total = totalBytes;
    state.progress.percentage = percentage;
    state.progress.stage = "downloading";
    state.progress.message = message || `Downloaded ${this.formatFileSize(downloadedBytes)}/${this.formatFileSize(totalBytes)}`;
    state.progress.speed = speed;
    state.progress.lastUpdateTime = now;
    state.progress.lastDownloaded = downloadedBytes;

    await DownloadStateManager.saveDownload(state);
    this.notifyProgress(state);
  }

  /**
   * Format file size helper
   */
  private formatFileSize(bytes: number): string {
    if (bytes < 1024) {
      return `${bytes.toFixed(0)} B`;
    } else if (bytes < 1024 * 1024) {
      return `${(bytes / 1024).toFixed(1)} KB`;
    } else if (bytes < 1024 * 1024 * 1024) {
      return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    } else {
      return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
    }
  }

  /**
   * Download a single fragment
   * Returns the size of the downloaded fragment in bytes
   */
  private async downloadFragment(
    fragment: Fragment,
    downloadId: string,
    fetchAttempts: number = 3,
  ): Promise<number> {
    try {
      // Fetch the fragment data
      const data = await fetchArrayBuffer(fragment.uri, fetchAttempts);

      // Check if encrypted and decrypt if needed
      const decryptedData = await decryptSingleFragment(
        fragment.key,
        data,
        fetchAttempts,
      );

      // Store in IndexedDB
      await storeChunk(downloadId, fragment.index, decryptedData);

      // Return the size of the downloaded fragment
      return decryptedData.byteLength;
    } catch (error) {
      logger.error(`Failed to download fragment ${fragment.index}:`, error);
      throw error;
    }
  }

  /**
   * Download all fragments with concurrency control
   * Tracks actual bytes downloaded instead of fragment count
   * Accumulates bytes across multiple calls (for video + audio)
   */
  private async downloadAllFragments(
    fragments: Fragment[],
    downloadId: string,
    stateId: string,
  ): Promise<void> {
    const totalFragments = fragments.length;
    let downloadedFragments = 0;
    let sessionBytesDownloaded = 0; // Bytes downloaded in this session
    const errors: Error[] = [];

    // Initialize progress tracking only if this is the first call
    if (this.lastUpdateTime === 0) {
      this.lastUpdateTime = Date.now();
      this.lastDownloadedBytes = 0;
    }

    // Estimate total size by downloading first fragment to get average size
    // This is a rough estimate, but better than showing fragment count
    let estimatedTotalBytes = 0;
    if (fragments.length > 0) {
      try {
        const firstFragmentSize = await this.downloadFragment(fragments[0], downloadId);
        sessionBytesDownloaded += firstFragmentSize;
        downloadedFragments++;
        this.bytesDownloaded += firstFragmentSize;
        
        // Estimate total based on first fragment size
        estimatedTotalBytes = firstFragmentSize * totalFragments;
        // Add to existing total if we already have bytes from previous calls
        if (this.totalBytes > 0) {
          estimatedTotalBytes += this.totalBytes - this.bytesDownloaded + firstFragmentSize;
        }
        this.totalBytes = Math.max(this.totalBytes, estimatedTotalBytes);
        
        await this.updateProgress(
          stateId,
          this.bytesDownloaded,
          this.totalBytes,
          `Downloading fragments...`,
        );
      } catch (error) {
        logger.error(`Failed to download first fragment for size estimation:`, error);
        // Fallback: use a default estimate or fragment count
        estimatedTotalBytes = 0;
      }
    }

    // Download remaining fragments with concurrency limit
    const downloadQueue: Promise<void>[] = [];
    let currentIndex = 1; // Start from index 1 since we already downloaded the first

    const downloadNext = async (): Promise<void> => {
      while (currentIndex < totalFragments) {
        const fragmentIndex = currentIndex++;
        const fragment = fragments[fragmentIndex];

        try {
          const fragmentSize = await this.downloadFragment(fragment, downloadId);
          sessionBytesDownloaded += fragmentSize;
          downloadedFragments++;
          this.bytesDownloaded += fragmentSize;
          
          // Update estimated total if we have better data
          if (estimatedTotalBytes === 0 || downloadedFragments > 0) {
            const averageFragmentSize = sessionBytesDownloaded / downloadedFragments;
            const sessionEstimatedTotal = averageFragmentSize * totalFragments;
            // Update total estimate, preserving bytes from previous sessions
            const previousBytes = this.bytesDownloaded - sessionBytesDownloaded;
            estimatedTotalBytes = previousBytes + sessionEstimatedTotal;
            this.totalBytes = Math.max(this.totalBytes, estimatedTotalBytes);
          }
          
          await this.updateProgress(
            stateId,
            this.bytesDownloaded,
            this.totalBytes,
            `Downloading fragments...`,
          );
        } catch (error) {
          const err = error instanceof Error ? error : new Error(String(error));
          errors.push(err);
          logger.error(`Fragment ${fragment.index} failed:`, err);
          // Continue with other fragments even if one fails
        }
      }
    };

    // Start concurrent downloads
    for (let i = 0; i < Math.min(this.maxConcurrent, totalFragments - downloadedFragments); i++) {
      downloadQueue.push(downloadNext());
    }

    // Wait for all downloads to complete
    await Promise.all(downloadQueue);

    // Update final progress with actual total (use current bytes as total if we've downloaded everything)
    this.totalBytes = Math.max(this.totalBytes, this.bytesDownloaded);
    await this.updateProgress(
      stateId,
      this.bytesDownloaded,
      this.totalBytes,
      `Downloaded ${downloadedFragments}/${totalFragments} fragments`,
    );

    // If there were errors, throw an error (but we still have some fragments)
    if (errors.length > 0 && downloadedFragments === 0) {
      throw new Error(`Failed to download any fragments: ${errors[0].message}`);
    }

    if (downloadedFragments < totalFragments) {
      logger.warn(`Downloaded ${downloadedFragments}/${totalFragments} fragments. Some fragments failed.`);
    }
  }

  /**
   * Process chunks using offscreen document and FFmpeg
   */
  private async streamToMp4Blob(
    fileName: string,
    stateId: string,
    onProgress?: (progress: number, message: string) => void,
  ): Promise<string> {
    // Ensure offscreen document exists
    await createOffscreenDocument();

    // Send processing request to offscreen document
    return new Promise<string>((resolve, reject) => {
      // Set up message listener for offscreen responses
      const messageListener = (message: any) => {
        if (
          message.type === MessageType.OFFSCREEN_PROCESS_HLS_RESPONSE &&
          message.payload?.downloadId === this.downloadId
        ) {
          const { type, blobUrl, error, progress, message: progressMessage } = message.payload;

          if (type === "success") {
            chrome.runtime.onMessage.removeListener(messageListener);
            resolve(blobUrl);
          } else if (type === "error") {
            chrome.runtime.onMessage.removeListener(messageListener);
            reject(new Error(error || "FFmpeg processing failed"));
          } else if (type === "progress") {
            // Forward progress updates
            onProgress?.(progress, progressMessage || "");
          }
        }
      };

      chrome.runtime.onMessage.addListener(messageListener);

      // Send processing request
      chrome.runtime.sendMessage({
        type: MessageType.OFFSCREEN_PROCESS_HLS,
        payload: {
          downloadId: this.downloadId,
          videoLength: this.videoLength,
          audioLength: this.audioLength,
          filename: fileName,
        },
      }, (response) => {
        // Check for errors to prevent "unchecked runtime.lastError" warning
        if (chrome.runtime.lastError) {
          chrome.runtime.onMessage.removeListener(messageListener);
          reject(new Error(`Failed to send processing request: ${chrome.runtime.lastError.message}`));
          return;
        }
        // Response is handled by messageListener
      });

      // Set timeout to prevent hanging
      setTimeout(() => {
        chrome.runtime.onMessage.removeListener(messageListener);
        reject(new Error("FFmpeg processing timeout"));
      }, 300000); // 5 minutes timeout
    });
  }

  /**
   * Save blob URL to file using Chrome downloads API
   */
  private async saveBlobUrlToFile(
    blobUrl: string,
    filename: string,
    stateId: string,
  ): Promise<string> {
    try {
      // Use Chrome downloads API to save the file
      return new Promise<string>((resolve, reject) => {
        chrome.downloads.download(
          {
            url: blobUrl,
            filename,
            saveAs: false,
          },
          (downloadId) => {
            if (chrome.runtime.lastError) {
              reject(new Error(chrome.runtime.lastError.message));
            } else {
              // Wait for download to complete
              const checkComplete = () => {
                chrome.downloads.search({ id: downloadId }, (results) => {
                  if (chrome.runtime.lastError) {
                    reject(new Error(chrome.runtime.lastError.message));
                    return;
                  }

                  const item = results?.[0];
                  if (!item) {
                    reject(new Error("Download item not found"));
                    return;
                  }

                  if (item.state === "complete") {
                    // Clean up blob URL after successful download
                    if (typeof URL !== 'undefined' && URL.revokeObjectURL) {
                      URL.revokeObjectURL(blobUrl);
                    }
                    resolve(item.filename);
                  } else if (item.state === "interrupted") {
                    if (typeof URL !== 'undefined' && URL.revokeObjectURL) {
                      URL.revokeObjectURL(blobUrl);
                    }
                    reject(new Error(item.error || "Download interrupted"));
                  } else {
                    // Check again in a bit
                    setTimeout(checkComplete, 100);
                  }
                });
              };

              checkComplete();
            }
          },
        );
      });
    } catch (error) {
      // Clean up blob URL on error
      if (typeof URL !== 'undefined' && URL.revokeObjectURL) {
        URL.revokeObjectURL(blobUrl);
      }
      throw error;
    }
  }

  /**
   * Select the best video and audio levels from master playlist
   */
  private selectLevels(levels: Level[]): { video: string | null; audio: string | null } {
    // Separate video and audio levels
    const videoLevels = levels.filter((level) => level.type === "stream");
    const audioLevels = levels.filter((level) => level.type === "audio");

    // Select best video level
    let videoUri: string | null = null;
    if (videoLevels.length > 0) {
      // Sort by bitrate (highest first) or resolution
      videoLevels.sort((a, b) => {
        if (a.bitrate && b.bitrate) {
          return b.bitrate - a.bitrate;
        }
        if (a.height && b.height) {
          return b.height - a.height;
        }
        return 0;
      });
      videoUri = videoLevels[0]?.uri || null;
    }

    // Select first audio level (or best if we want to add selection logic)
    const audioUri = audioLevels.length > 0 ? audioLevels[0]?.uri || null : null;

    return { video: videoUri, audio: audioUri };
  }

  /**
   * Download HLS video
   */
  async download(
    masterPlaylistUrl: string,
    filename: string,
    stateId: string,
  ): Promise<{ filePath: string; fileExtension?: string }> {
    try {
      logger.info(`Starting HLS download from ${masterPlaylistUrl}`);

      // Initialize downloadId
      this.downloadId = stateId;
      this.videoLength = 0;
      this.audioLength = 0;

      // Update progress: parsing playlist
      await this.updateProgress(stateId, 0, 0, "Parsing playlist...");

      // Fetch and parse master playlist
      const masterPlaylistText = await fetchText(masterPlaylistUrl, 3);
      const levels = parseMasterPlaylist(masterPlaylistText, masterPlaylistUrl);

      if (levels.length === 0) {
        throw new Error("No levels found in master playlist");
      }

      // Select video and audio levels
      const { video: videoPlaylistUrl, audio: audioPlaylistUrl } = this.selectLevels(levels);

      if (!videoPlaylistUrl && !audioPlaylistUrl) {
        throw new Error("No video or audio levels found in master playlist");
      }

      logger.info(`Selected video: ${videoPlaylistUrl || "none"}, audio: ${audioPlaylistUrl || "none"}`);

      // Initialize byte tracking
      this.bytesDownloaded = 0;
      this.totalBytes = 0;
      this.lastUpdateTime = 0;
      this.lastDownloadedBytes = 0;

      // Download video fragments
      if (videoPlaylistUrl) {
        const videoPlaylistText = await fetchText(videoPlaylistUrl, 3);
        const videoFragments = parseLevelsPlaylist(videoPlaylistText, videoPlaylistUrl);

        if (videoFragments.length === 0) {
          throw new Error("No video fragments found in level playlist");
        }

        logger.info(`Found ${videoFragments.length} video fragments`);

        // Assign indices starting from 0
        const indexedVideoFragments = videoFragments.map((frag, idx) => ({
          ...frag,
          index: idx,
        }));

        this.videoLength = indexedVideoFragments.length;

        // Download video fragments (downloadAllFragments handles progress internally)
        await this.downloadAllFragments(indexedVideoFragments, this.downloadId, stateId);
      }

      // Download audio fragments
      if (audioPlaylistUrl) {
        const audioPlaylistText = await fetchText(audioPlaylistUrl, 3);
        const audioFragments = parseLevelsPlaylist(audioPlaylistText, audioPlaylistUrl);

        if (audioFragments.length === 0) {
          throw new Error("No audio fragments found in level playlist");
        }

        logger.info(`Found ${audioFragments.length} audio fragments`);

        // Assign indices starting from videoLength
        const indexedAudioFragments = audioFragments.map((frag, idx) => ({
          ...frag,
          index: this.videoLength + idx,
        }));

        this.audioLength = indexedAudioFragments.length;

        // Continue downloading audio fragments (bytes accumulate from video)
        // Note: downloadAllFragments will continue from where video left off
        await this.downloadAllFragments(indexedAudioFragments, this.downloadId, stateId);
      }

      // Update progress: merging with FFmpeg
      const mergingState = await DownloadStateManager.getDownload(stateId);
      if (mergingState) {
        mergingState.progress.stage = "merging";
        mergingState.progress.message = "Merging streams...";
        await DownloadStateManager.saveDownload(mergingState);
        this.notifyProgress(mergingState);
      }

      // Extract base filename without extension
      const baseFileName = filename.replace(/\.[^/.]+$/, "");

      // Process chunks using offscreen document and FFmpeg
      const blobUrl = await this.streamToMp4Blob(
        baseFileName,
        stateId,
        async (progress, message) => {
          // Update progress during FFmpeg processing
          // Progress is 0-1, map it to 80-100% of total (since fragments are done)
          const state = await DownloadStateManager.getDownload(stateId);
          if (state) {
            // FFmpeg processing happens after all fragments are downloaded
            // So we map 0-1 progress to 80-100% of total progress
            state.progress.percentage = 80 + progress * 20;
            state.progress.message = message;
            state.progress.stage = "merging";
            await DownloadStateManager.saveDownload(state);
            this.notifyProgress(state);
          }
        },
      );

      // Update progress: saving (set stage to "saving" instead of "downloading")
      const savingState = await DownloadStateManager.getDownload(stateId);
      if (savingState) {
        savingState.progress.stage = "saving";
        savingState.progress.message = "Saving file...";
        savingState.progress.percentage = 95; // Close to completion
        await DownloadStateManager.saveDownload(savingState);
        this.notifyProgress(savingState);
      }

      // Save to file using blob URL
      const filePath = await this.saveBlobUrlToFile(blobUrl, `${baseFileName}.mp4`, stateId);

      // Clean up IndexedDB chunks
      await deleteChunks(this.downloadId);

      // Update progress: completed
      const finalState = await DownloadStateManager.getDownload(stateId);
      if (finalState) {
        finalState.localPath = filePath;
        finalState.progress.stage = "completed";
        finalState.progress.message = "Download completed";
        finalState.progress.percentage = 100;
        // Ensure downloaded equals total for completed state
        finalState.progress.downloaded = finalState.progress.total || this.bytesDownloaded || 0;
        finalState.updatedAt = Date.now();
        await DownloadStateManager.saveDownload(finalState);
        this.notifyProgress(finalState);
        
        // Ensure state is persisted by reading it back and verifying
        const verifyState = await DownloadStateManager.getDownload(stateId);
        if (verifyState && verifyState.progress.stage !== "completed") {
          logger.warn(`State verification failed for ${stateId}, retrying...`);
          verifyState.progress.stage = "completed";
          verifyState.progress.message = "Download completed";
          verifyState.progress.percentage = 100;
          await DownloadStateManager.saveDownload(verifyState);
          this.notifyProgress(verifyState);
        }
      } else {
        logger.error(`Could not find download state ${stateId} to mark as completed`);
      }

      logger.info(`HLS download completed: ${filePath}`);

      return {
        filePath,
        fileExtension: "mp4",
      };
    } catch (error) {
      logger.error("HLS download failed:", error);

      // Try to clean up IndexedDB on error
      try {
        await deleteChunks(this.downloadId || stateId);
      } catch (cleanupError) {
        logger.error("Failed to clean up chunks:", cleanupError);
      }

      throw error instanceof DownloadError
        ? error
        : new DownloadError(`HLS download failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Notify progress callback
   */
  private notifyProgress(state: DownloadState): void {
    if (this.onProgress) {
      this.onProgress(state);
    }
  }
}

