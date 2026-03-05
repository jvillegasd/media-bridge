/**
 * Background service worker for download orchestration
 * Handles download requests, state management, and CORS bypass for content scripts
 */

import { DownloadManager } from "./core/downloader/download-manager";
import { HlsRecordingHandler } from "./core/downloader/hls/hls-recording-handler";
import { DashRecordingHandler } from "./core/downloader/dash/dash-recording-handler";
import {
  getAllDownloads,
  getDownload,
  getDownloadByUrl,
  storeDownload,
  deleteDownload,
} from "./core/database/downloads";
import { UploadManager } from "./core/cloud/upload-manager";
import { S3Client } from "./core/cloud/s3-client";
import { ChromeStorage } from "./core/storage/chrome-storage";
import { loadSettings } from "./core/storage/settings";
import { SecureStorage } from "./core/storage/secure-storage";
import { MessageType, CloudProvider } from "./shared/messages";
import {
  DownloadState,
  StorageConfig,
  VideoMetadata,
  DownloadStage,
  VideoFormat,
} from "./core/types";
import { CancellationError } from "./core/utils/errors";
import { generateDownloadId } from "./core/utils/id-utils";
import { logger } from "./core/utils/logger";
import {
  canCancelDownload,
  CANNOT_CANCEL_MESSAGE,
} from "./core/utils/download-utils";
import { normalizeUrl, detectFormatFromUrl } from "./core/utils/url-utils";
import {
  generateFilenameWithExtension,
  generateFilenameFromTabInfo,
} from "./core/utils/file-utils";
import {
  deleteChunks,
  getAllChunks,
  getChunkCount,
  getAllChunkDownloadIds,
} from "./core/database/chunks";
import {
  createOffscreenDocument,
  closeOffscreenDocument,
} from "./core/ffmpeg/offscreen-manager";
import {
  KEEPALIVE_INTERVAL_MS,
  STORAGE_CONFIG_KEY,
} from "./shared/constants";

const activeDownloads = new Map<string, Promise<void>>();
const activeUploads = new Set<string>();
const uploadAbortControllers = new Map<string, AbortController>();
// Map to store AbortControllers for each download (keyed by normalized URL)
const downloadAbortControllers = new Map<string, AbortController>();
// Set of normalized URLs that should save partial progress on abort
const savePartialDownloads = new Set<string>();

/**
 * Keep-alive heartbeat mechanism to prevent service worker termination
 * Calls chrome.runtime.getPlatformInfo() every 20 seconds to keep worker alive
 * during long-running operations like downloads and FFmpeg processing
 *
 * Source: https://stackoverflow.com/a/66618269
 */
const keepAlive = (
  (i?: ReturnType<typeof setInterval> | 0) => (state: boolean) => {
    if (state && !i) {
      // If service worker has been running for more than 20 seconds, call immediately
      if (performance.now() > KEEPALIVE_INTERVAL_MS)
        chrome.runtime.getPlatformInfo();
      i = setInterval(
        () => chrome.runtime.getPlatformInfo(),
        KEEPALIVE_INTERVAL_MS,
      );
    } else if (!state && i) {
      clearInterval(i);
      i = 0;
    }
  }
)();

function updateKeepAlive(): void {
  keepAlive(activeDownloads.size > 0 || activeUploads.size > 0);
}

/**
 * Initialize service worker
 */
async function init() {
  logger.info("Service worker initialized");
  chrome.runtime.onInstalled.addListener(handleInstallation);

  // Cleanup orphaned chunks from previous crashes (non-blocking)
  cleanupStaleChunks().catch((err) =>
    logger.error("Orphaned chunk cleanup failed:", err),
  );

  // Clean up orphaned S3 multipart uploads from previous crashes
  cleanupOrphanedS3Uploads().catch((err) =>
    logger.error("S3 orphaned upload cleanup failed:", err),
  );

  // Restore downloads stuck in UPLOADING stage after a crash
  cleanupStaleUploads().catch((err) =>
    logger.error("Stale upload cleanup failed:", err),
  );
}

/**
 * Remove chunks whose download no longer exists or is in a finished state.
 * Runs once at startup to reclaim IndexedDB storage from crashed downloads.
 */
async function cleanupStaleChunks(): Promise<void> {
  const chunkDownloadIds = await getAllChunkDownloadIds();
  if (chunkDownloadIds.length === 0) return;

  const results = await Promise.all(
    chunkDownloadIds.map(async (downloadId) => {
      const download = await getDownload(downloadId);
      const isOrphaned =
        !download ||
        download.progress.stage === DownloadStage.COMPLETED ||
        download.progress.stage === DownloadStage.FAILED ||
        download.progress.stage === DownloadStage.CANCELLED;
      if (isOrphaned) {
        await deleteChunks(downloadId);
        return true;
      }
      return false;
    }),
  );

  const cleaned = results.filter(Boolean).length;
  if (cleaned > 0) {
    logger.info(`Cleaned up orphaned chunks for ${cleaned} download(s)`);
  }
}

/**
 * Abort orphaned S3 multipart uploads persisted from a previous service worker session.
 */
async function cleanupOrphanedS3Uploads(): Promise<void> {
  const settings = await loadSettings();
  const secret = await resolveS3Secret(settings.s3);
  const s3 = settings.s3;
  const config =
    s3.bucket && s3.region && s3.accessKeyId && secret
      ? { bucket: s3.bucket, region: s3.region, accessKeyId: s3.accessKeyId, secretAccessKey: secret, endpoint: s3.endpoint, prefix: s3.prefix }
      : undefined;
  await S3Client.cleanupOrphanedUploads(config);
}

/**
 * Restore downloads stuck in UPLOADING stage after a service worker crash.
 */
async function cleanupStaleUploads(): Promise<void> {
  const all = await getAllDownloads();
  for (const d of all) {
    if (d.progress.stage === DownloadStage.UPLOADING) {
      d.progress.stage = DownloadStage.COMPLETED;
      d.progress.message = "Upload interrupted";
      d.progress.percentage = undefined;
      await storeDownload(d);
    }
  }
}

/**
 * Handle extension installation
 */
function handleInstallation(details: chrome.runtime.InstalledDetails) {
  if (details.reason === "install") {
    logger.info("Extension installed");
  }
}

/**
 * Handle download request message
 */
async function handleDownloadRequestMessage(payload: {
  url: string;
  filename?: string;
  metadata: VideoMetadata;
  tabTitle?: string;
  website?: string;
  manifestQuality?: {
    videoPlaylistUrl?: string | null;
    audioPlaylistUrl?: string | null;
    selectedBandwidth?: number;
  };
}): Promise<{ success: boolean; error?: string }> {
  try {
    const downloadResult = await handleDownloadRequest(payload);
    if (downloadResult?.error) return { success: false, error: downloadResult.error };
    return { success: true };
  } catch (error) {
    logger.error("Download request error:", error);
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Handle get downloads message
 */
async function handleGetDownloadsMessage(): Promise<{
  success: boolean;
  data?: DownloadState[];
  error?: string;
}> {
  try {
    const downloads = await getAllDownloads();
    return { success: true, data: downloads };
  } catch (error) {
    logger.error("Get downloads error:", error);
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Handle cancel download message
 */
async function handleCancelDownloadMessage(
  id: string,
): Promise<{ success: boolean; error?: string }> {
  try {
    await handleCancelDownload(id);
    return { success: true };
  } catch (error) {
    logger.error("Cancel download error:", error);
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Handle get config message
 */
async function handleGetConfigMessage(): Promise<{
  success: boolean;
  data?: StorageConfig;
  error?: string;
}> {
  try {
    const config = await ChromeStorage.get<StorageConfig>(STORAGE_CONFIG_KEY);
    return { success: true, data: config || undefined };
  } catch (error) {
    logger.error("Get config error:", error);
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Handle save config message
 */
async function handleSaveConfigMessage(
  payload: StorageConfig,
): Promise<{ success: boolean; error?: string }> {
  try {
    await ChromeStorage.set(STORAGE_CONFIG_KEY, payload);
    return { success: true };
  } catch (error) {
    logger.error("Save config error:", error);
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Handle fetch resource message (CORS bypass)
 * Content scripts send fetch requests through service worker to bypass CORS
 */
async function handleFetchResourceMessage(payload: {
  input: string;
  init: {
    method?: string;
    headers?: Record<string, string>;
    body?: number[];
    mode?: RequestMode;
  };
}): Promise<
  [
    {
      body: number[];
      status: number;
      statusText: string;
      headers: Record<string, string>;
    } | null,
    Error | null,
  ]
> {
  try {
    const { input, init } = payload;

    let body: BodyInit | null = null;
    if (init.body) {
      body = new Uint8Array(init.body).buffer;
    }

    const fetchInit: RequestInit = {
      method: init.method || "GET",
      headers: init.headers || {},
      body: body,
      mode: init.mode,
    };

    const response = await fetch(input, fetchInit);
    const arrayBuffer = await response.arrayBuffer();

    const headersObj: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      headersObj[key] = value;
    });

    return [
      {
        body: Array.from(new Uint8Array(arrayBuffer)),
        status: response.status,
        statusText: response.statusText,
        headers: headersObj,
      },
      null,
    ];
  } catch (error) {
    return [null, error instanceof Error ? error : new Error(String(error))];
  }
}

/**
 * Set up network interceptor to detect video URLs
 * Intercepts completed network requests and sends valid video URLs to content scripts
 * Using onCompleted ensures the request has finished (better for autoplay scenarios)
 */
chrome.webRequest.onCompleted.addListener(
  (details) => {
    const url = details.url;
    logger.info(`Network request completed: ${url}`);
    // Detect if this is a video URL
    const format = detectFormatFromUrl(url);
    if (format === VideoFormat.UNKNOWN) {
      return;
    }

    // Send URL to content script in the tab that made the request
    if (details.tabId && details.tabId > 0) {
      chrome.tabs.sendMessage(
        details.tabId,
        {
          type: MessageType.NETWORK_URL_DETECTED,
          payload: { url },
        },
        (response) => {
          // Check for errors to prevent "unchecked runtime.lastError" warning
          if (chrome.runtime.lastError) {
            // Ignore - content script might not be available or tab closed
          }
        },
      );
    }
  },
  {
    urls: [
      "http://*/*.m3u8",
      "https://*/*.m3u8",
      "http://*/*.m3u8?*",
      "https://*/*.m3u8?*",
      "http://*/*.mpd",
      "https://*/*.mpd",
      "http://*/*.mpd?*",
      "https://*/*.mpd?*",
    ],
    types: ["xmlhttprequest"],
  },
  ["responseHeaders"],
);

/**
 * Handle messages from popup and content scripts
 * Processes download requests, state queries, config management, and CORS bypass requests
 */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  try {
    switch (message.type) {
      case MessageType.DOWNLOAD_REQUEST:
        handleDownloadRequestMessage(message.payload).then(sendResponse);
        return true; // Return true to indicate async response

      case MessageType.GET_DOWNLOADS:
        handleGetDownloadsMessage().then(sendResponse);
        return true;

      case MessageType.CANCEL_DOWNLOAD:
        handleCancelDownloadMessage(message.payload.id).then(sendResponse);
        return true;

      case MessageType.GET_CONFIG:
        handleGetConfigMessage().then(sendResponse);
        return true;

      case MessageType.SAVE_CONFIG:
        handleSaveConfigMessage(message.payload).then(sendResponse);
        return true;

      case MessageType.FETCH_RESOURCE:
        handleFetchResourceMessage(message.payload).then(sendResponse);
        return true;

      case MessageType.VIDEO_DETECTED:
        // This message is sent from content script to popup
        // Service worker doesn't need to handle it, just ignore silently
        return false;

      case MessageType.SET_ICON_BLUE:
        handleSetIconBlue(sender.tab?.id);
        return false;

      case MessageType.SET_ICON_GRAY:
        handleSetIconGray(sender.tab?.id);
        return false;

      case MessageType.START_RECORDING:
        handleStartRecordingMessage(message.payload).then(sendResponse);
        return true;

      case MessageType.STOP_RECORDING:
        handleStopRecordingMessage(message.payload).then(sendResponse);
        return true;

      case MessageType.STOP_AND_SAVE_DOWNLOAD:
        handleStopAndSaveMessage(message.payload).then(sendResponse);
        return true;

      case MessageType.UPLOAD_REQUEST:
        handleUploadRequestMessage(message.payload).then(sendResponse);
        return true;

      case MessageType.CANCEL_UPLOAD: {
        (async () => {
          const uid = message.payload?.downloadId as string | undefined;
          if (uid) {
            const ctrl = uploadAbortControllers.get(uid);
            if (ctrl) {
              ctrl.abort();
              // Remove from tracking immediately so onStateUpdate stops writing
              uploadAbortControllers.delete(uid);
              activeUploads.delete(uid);
              // Restore COMPLETED stage — awaited so deleteDownload() won't race
              const s = await getDownload(uid);
              if (s) {
                s.progress.stage = DownloadStage.COMPLETED;
                s.progress.message = "Upload cancelled";
                s.progress.percentage = undefined;
                await storeDownload(s);
              }
            }
          }
          sendResponse({ success: true });
        })();
        return true;
      }

      case MessageType.CHECK_URL: {
        const checkUrl = async () => {
          try {
            const format = detectFormatFromUrl(message.payload.url);
            const isManifest =
              format === VideoFormat.DASH || format === VideoFormat.HLS;
            const res = await fetch(message.payload.url, {
              method: isManifest ? "GET" : "HEAD",
              signal: AbortSignal.timeout(5000),
            });
            return { ok: res.ok, status: res.status };
          } catch {
            return { ok: false, status: 0 };
          }
        };
        checkUrl().then(sendResponse);
        return true;
      }

      case MessageType.OFFSCREEN_PROCESS_HLS_RESPONSE:
      case MessageType.OFFSCREEN_PROCESS_M3U8_RESPONSE:
      case MessageType.OFFSCREEN_PROCESS_DASH_RESPONSE:
        // Handled by ffmpeg-bridge's dynamic onMessage listener in processWithFFmpeg()
        return false;

      default:
        // Only log warnings for truly unknown message types
        // Some messages might be handled by other listeners (like content scripts)
        logger.warn(`Unknown message type: ${message.type}`);
        sendResponse({ success: false, error: "Unknown message type" });
        return false;
    }
  } catch (error) {
    logger.error("Message handling error:", error);
    sendResponse({
      success: false,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
});

async function cleanupOrphanedChunks(existing: DownloadState) {
  if (
    existing.metadata.format !== VideoFormat.HLS &&
    existing.metadata.format !== VideoFormat.M3U8 &&
    existing.metadata.format !== VideoFormat.DASH
  ) {
    return;
  }

  logger.info(
    `Cleaning up orphaned chunks for ${existing.progress.stage} download ${existing.id}`,
  );

  try {
    const chunkCount = await getChunkCount(existing.id);
    if (chunkCount > 0) {
      logger.warn(
        `Orphaned chunks found for ${existing.progress.stage} download ${existing.id}: ${chunkCount} chunks remaining`,
      );
      await deleteChunks(existing.id);
    } else {
      logger.info(
        `Successfully cleaned up orphaned chunks for ${existing.progress.stage} download ${existing.id}`,
      );
    }
  } catch (error) {
    logger.error(
      `Error verifying chunk cleanup for ${existing.progress.stage} download ${existing.id}:`,
      error,
    );
    // Don't throw - continue with download even if cleanup verification fails
  }
}

/**
 * Resolve the S3 secret access key, decrypting it if stored as an EncryptedBlob.
 * Returns undefined and logs a warning if the passphrase is missing from session storage.
 */
async function resolveS3Secret(
  s3: { secretAccessKey?: string; secretKeyEncrypted?: import("./core/types").EncryptedBlob },
): Promise<string | undefined> {
  if (s3.secretKeyEncrypted) {
    const passphrase = await SecureStorage.getPassphrase();
    if (!passphrase) {
      logger.warn("S3 upload skipped: passphrase not in session. Open Options → S3 and re-enter your passphrase.");
      return undefined;
    }
    try {
      return await SecureStorage.decrypt(s3.secretKeyEncrypted, passphrase);
    } catch {
      logger.error("S3 upload skipped: failed to decrypt secret key — wrong passphrase?");
      return undefined;
    }
  }
  return s3.secretAccessKey;
}

/**
 * Process download request
 * Validates request, checks for duplicates, creates download manager, and starts download
 */
async function handleDownloadRequest(payload: {
  url: string;
  filename?: string;
  metadata: VideoMetadata;
  tabTitle?: string;
  website?: string;
  manifestQuality?: {
    videoPlaylistUrl?: string | null;
    audioPlaylistUrl?: string | null;
    selectedBandwidth?: number;
  };
  isManual?: boolean;
}): Promise<{ error?: string } | void> {
  const {
    url,
    filename,
    metadata,
    tabTitle,
    website,
    manifestQuality,
    isManual,
  } = payload;
  const normalizedUrl = normalizeUrl(url);
  const existing = await getDownloadByUrl(normalizedUrl);

  if (existing && existing.progress.stage === DownloadStage.COMPLETED) {
    logger.info(`Redownloading completed video: ${normalizedUrl}`);
    await deleteDownload(existing.id);
  }

  if (
    existing &&
    (existing.progress.stage === DownloadStage.FAILED ||
      existing.progress.stage === DownloadStage.CANCELLED)
  ) {
    logger.info(`Retrying failed or cancelled download: ${normalizedUrl}`);
    await deleteDownload(existing.id);
    // Also ensure it's removed from activeDownloads map
    activeDownloads.delete(normalizedUrl);

    await cleanupOrphanedChunks(existing);
  }

  if (activeDownloads.has(normalizedUrl)) {
    logger.info(`Download already in progress: ${normalizedUrl}`);
    return {
      error: "Download is already in progress. Please wait for it to complete.",
    };
  }

  const config = await loadSettings();

  const downloadManager = new DownloadManager({
    maxConcurrent: config.maxConcurrent,
    ffmpegTimeout: config.ffmpegTimeout,
    maxRetries: config.advanced.maxRetries,
    retryDelayMs: config.advanced.retryDelayMs,
    retryBackoffFactor: config.advanced.retryBackoffFactor,
    fragmentFailureRate: config.advanced.fragmentFailureRate,
    dbSyncIntervalMs: config.advanced.dbSyncIntervalMs,
    minPollIntervalMs: config.recording.minPollIntervalMs,
    maxPollIntervalMs: config.recording.maxPollIntervalMs,
    pollFraction: config.recording.pollFraction,
    shouldSaveOnCancel: () => savePartialDownloads.has(normalizedUrl),
    onProgress: async (state) => {
      // Use the pre-normalized URL from the outer scope instead of re-normalizing
      const normalizedUrlForProgress = normalizedUrl;

      // Get abort controller and store signal reference ONCE to avoid stale reference issues
      const controller = downloadAbortControllers.get(normalizedUrlForProgress);
      // Allow progress updates through if we're in stop-and-save mode (partial save in progress)
      const isSavingPartial = savePartialDownloads.has(
        normalizedUrlForProgress,
      );

      // If no controller exists (already cleaned up) or signal is aborted, skip update
      // BUT allow updates through if we're saving a partial download
      if (!isSavingPartial && (!controller || controller.signal.aborted)) {
        logger.info(
          `Download ${state.id} was aborted, ignoring progress update`,
        );
        return;
      }

      // Final abort check immediately before storing to minimize race window
      if (!isSavingPartial && controller?.signal.aborted) {
        logger.info(
          `Download ${state.id} was aborted, ignoring progress update`,
        );
        return;
      }

      await storeDownload(state);
      // Send progress update - handle errors gracefully (popup might be closed)
      try {
        chrome.runtime.sendMessage(
          {
            type: MessageType.DOWNLOAD_PROGRESS,
            payload: {
              id: state.id,
              progress: state.progress,
            },
          },
          () => {
            // Check for errors in callback
            if (chrome.runtime.lastError) {
              // Ignore - popup/content script might not be listening
            }
          },
        );
      } catch (error) {
        // Ignore errors - popup/content script might not be listening
      }
    },
  });

  // Create AbortController for this download to enable real-time cancellation
  const abortController = new AbortController();
  downloadAbortControllers.set(normalizedUrl, abortController);

  const downloadPromise = startDownload(
    downloadManager,
    url,
    filename,
    metadata,
    tabTitle,
    website,
    manifestQuality,
    isManual,
    abortController.signal, // Pass AbortSignal for real-time cancellation
  );
  activeDownloads.set(normalizedUrl, downloadPromise);

  // Start keep-alive if this is the first active operation
  if (activeDownloads.size === 1) {
    updateKeepAlive();
    // Pre-warm FFmpeg for HLS/M3U8/DASH downloads while segments download
    if (
      metadata.format === VideoFormat.HLS ||
      metadata.format === VideoFormat.M3U8 ||
      metadata.format === VideoFormat.DASH
    ) {
      createOffscreenDocument()
        .then(() =>
          chrome.runtime.sendMessage({ type: MessageType.WARMUP_FFMPEG }),
        )
        .catch((err) => logger.error("FFmpeg pre-warm failed:", err));
    }
  }

  downloadPromise
    .then(async () => {
      await cleanupDownloadResources(normalizedUrl);
      const cfg = await loadSettings();
      if (!cfg.historyEnabled) {
        const completed = await getDownloadByUrl(normalizedUrl);
        if (completed) await deleteDownload(completed.id);
      }
    })
    .catch(async (error: unknown) => {
      // Only log error if not cancelled
      if (error instanceof CancellationError) {
        // Cancellation already handled, don't log as error
        await cleanupDownloadResources(normalizedUrl);
        return;
      } else if (error instanceof Error) {
        logger.error(`Download failed for ${url}:`, error);
      } else {
        logger.error(`Download failed for ${url}:`, String(error));
      }
      await cleanupDownloadResources(normalizedUrl);
      const cfg = await loadSettings();
      if (!cfg.historyEnabled) {
        const failed = await getDownloadByUrl(normalizedUrl);
        if (failed) await deleteDownload(failed.id);
      }
    })
    .finally(() => {
      // Ensure promise is removed from activeDownloads when it completes
      // This handles both success and failure cases
      activeDownloads.delete(normalizedUrl);

      // Stop keep-alive if no more active operations
      if (activeDownloads.size === 0) {
        updateKeepAlive();
        closeOffscreenDocument().catch((err) =>
          logger.error("Failed to close offscreen document:", err),
        );
      }
    });
}

/** Extract a short, user-friendly message from an upload error. Full details stay in console logs. */
function friendlyUploadError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);

  // Try to extract the S3/R2 XML <Code> (e.g. "SignatureDoesNotMatch", "AccessDenied")
  const codeMatch = msg.match(/<Code>(.+?)<\/Code>/);
  const status = (err as any)?.statusCode as number | undefined;

  if (codeMatch?.[1]) {
    const code = codeMatch[1];
    const friendly: Record<string, string> = {
      AccessDenied: "Access denied — check your API token permissions",
      SignatureDoesNotMatch: "Signature mismatch — verify your secret access key",
      NoSuchBucket: "Bucket not found — check your bucket name",
      InvalidAccessKeyId: "Invalid access key ID",
      ExpiredToken: "Security token has expired",
    };
    return friendly[code] ?? `Upload failed: ${code}`;
  }

  // CORS preflight failures have no response body
  if (msg.includes("Failed to fetch") || msg.includes("NetworkError")) {
    return "Network error — check CORS configuration and endpoint URL";
  }

  if (status) {
    return `Upload failed (HTTP ${status})`;
  }

  // Fallback: truncate to something reasonable
  return msg.length > 120 ? msg.slice(0, 117) + "…" : msg;
}

/**
 * Handle deferred upload request (triggered from popup or history after download completes).
 * Since the blob URL is long gone, this re-downloads the segments and re-processes — OR
 * if the localPath file is accessible (DIRECT downloads), it re-downloads from the source URL.
 *
 * For segmented downloads (HLS/DASH/M3U8), re-downloading is expensive and URLs may have
 * expired. The popup should prompt the user to select the local file via showOpenFilePicker().
 * This handler receives the file bytes forwarded from the popup after file picker selection.
 */
async function handleUploadRequestMessage(payload: {
  downloadId: string;
  provider: CloudProvider;
}): Promise<{ success: boolean; error?: string }> {
  const { downloadId, provider } = payload;

  if (activeUploads.has(downloadId)) {
    return { success: false, error: "Upload already in progress" };
  }

  const abortController = new AbortController();
  uploadAbortControllers.set(downloadId, abortController);
  activeUploads.add(downloadId);
  updateKeepAlive();

  try {
    // Always clean up the temp IDB blob, even on early-return errors
    const tempKey = `__upload_${downloadId}`;
    const chunks = await getAllChunks(tempKey);
    await deleteChunks(tempKey);

    const state = await getDownload(downloadId);
    if (!state) return { success: false, error: "Download not found" };
    if (state.metadata.hasDrm) return { success: false, error: "DRM-protected content cannot be uploaded" };
    if (!chunks.length || !chunks[0].byteLength) {
      logger.warn(`Upload request for ${downloadId}: no file data in IDB (chunks=${chunks.length})`);
      return { success: false, error: "No file data provided" };
    }
    const fileBytes = chunks[0];

    // Clear any previous upload error so the UI reflects the retry in progress
    if (state.uploadError) {
      state.uploadError = undefined;
      await storeDownload(state);
    }

    const config = await loadSettings();
    const blob = new Blob([fileBytes], { type: "video/mp4" });
    const filename = state.localPath?.split(/[/\\]/).pop() ?? "video.mp4";

    const storageConfig = {
      googleDrive: { ...config.googleDrive },
      s3: { ...config.s3, secretAccessKey: await resolveS3Secret(config.s3) },
    };

    const uploadManager = new UploadManager({
      config: storageConfig,
      onStateUpdate: async (updatedState) => {
        // Skip IDB write if upload was cancelled (record may be deleted)
        if (abortController.signal.aborted || !activeUploads.has(updatedState.id)) return;
        await storeDownload(updatedState);
        try {
          chrome.runtime.sendMessage(
            { type: MessageType.DOWNLOAD_PROGRESS, payload: { id: updatedState.id, progress: updatedState.progress } },
            () => { if (chrome.runtime.lastError) {} },
          );
        } catch (_) {}
      },
    });

    if (!uploadManager.isConfigured()) {
      return { success: false, error: "No cloud provider configured" };
    }

    const links = await uploadManager.uploadBlob(blob, filename, state, provider, abortController.signal);

    if (abortController.signal.aborted) {
      return { success: false, error: "Upload cancelled" };
    }

    const freshState = await getDownload(downloadId);
    if (freshState) {
      freshState.cloudLinks = { ...freshState.cloudLinks, ...links };
      freshState.uploadError = undefined;
      freshState.progress.stage = DownloadStage.COMPLETED;
      freshState.progress.message = "Upload complete";
      await storeDownload(freshState);
      try {
        chrome.runtime.sendMessage(
          { type: MessageType.UPLOAD_COMPLETE, payload: { id: downloadId, cloudLinks: links } },
          () => { if (chrome.runtime.lastError) {} },
        );
      } catch (_) {}
    }

    return { success: true };
  } catch (err) {
    // If aborted, the CANCEL_UPLOAD handler already restored the state
    if (abortController.signal.aborted) {
      return { success: false, error: "Upload cancelled" };
    }
    logger.error("Upload request failed:", err);
    const fullMsg = err instanceof Error ? err.message : String(err);
    const userMsg = friendlyUploadError(err);
    // Persist the error so the popup can show a retry button
    const failedState = await getDownload(downloadId);
    if (failedState) {
      failedState.uploadError = fullMsg;
      failedState.progress.stage = DownloadStage.COMPLETED;
      await storeDownload(failedState);
      try {
        chrome.runtime.sendMessage(
          { type: MessageType.DOWNLOAD_PROGRESS, payload: { id: downloadId, progress: failedState.progress } },
          () => { if (chrome.runtime.lastError) {} },
        );
      } catch (_) {}
    }
    return { success: false, error: userMsg };
  } finally {
    uploadAbortControllers.delete(downloadId);
    activeUploads.delete(downloadId);
    updateKeepAlive();
  }
}

/**
 * Send download completion message to popup
 */
function sendDownloadComplete(downloadId: string): void {
  try {
    chrome.runtime.sendMessage(
      {
        type: MessageType.DOWNLOAD_COMPLETE,
        payload: { id: downloadId },
      },
      () => {
        // Check for errors in callback
        if (chrome.runtime.lastError) {
          // Ignore - popup/content script might not be listening
        }
      },
    );
  } catch (error) {
    // Ignore errors - popup/content script might not be listening
  }
  // Fire post-download actions (notifications, auto-open) if configured
  handlePostDownloadActions(downloadId);
}

async function handlePostDownloadActions(downloadId: string): Promise<void> {
  try {
    const { notifications } = await loadSettings();
    if (!notifications.notifyOnCompletion && !notifications.autoOpenFile) return;

    const state = await getDownload(downloadId);
    if (!state) return;

    const title = state.metadata.title || "Media Bridge";
    const filename = state.localPath?.split(/[/\\]/).pop() ?? "Download";

    if (notifications.notifyOnCompletion) {
      chrome.notifications.create(`download-complete-${downloadId}`, {
        type: "basic",
        iconUrl: "icons/icon-48.png",
        title: "Download complete",
        message: `${title}\n${filename}`,
      });
    }

    if (notifications.autoOpenFile && state.chromeDownloadId != null) {
      chrome.downloads.show(state.chromeDownloadId);
    }
  } catch (err) {
    logger.warn("handlePostDownloadActions failed:", err);
  }
}

/**
 * Send download failure message to popup
 */
function sendDownloadFailed(url: string, error: string): void {
  try {
    chrome.runtime.sendMessage(
      {
        type: MessageType.DOWNLOAD_FAILED,
        payload: { url, error },
      },
      () => {
        // Check for errors in callback
        if (chrome.runtime.lastError) {
          // Ignore - popup/content script might not be listening
        }
      },
    );
  } catch (error) {
    // Ignore errors - popup/content script might not be listening
  }
}

/**
 * Check if download state indicates failure
 */
function isDownloadFailed(downloadState: DownloadState): boolean {
  return downloadState.progress.stage === DownloadStage.FAILED;
}

/**
 * Clean up download resources after completion or cancellation
 */
async function cleanupDownloadResources(normalizedUrl: string): Promise<void> {
  // Clean up AbortController
  downloadAbortControllers.delete(normalizedUrl);
  // Clean up stop-and-save marker
  savePartialDownloads.delete(normalizedUrl);

  // Note: activeDownloads cleanup is handled in the promise's finally block
  // to ensure it's removed regardless of success/failure/cancellation
}

/**
 * Cancel Chrome downloads associated with a download state
 * Only cancels if chromeDownloadId is set (direct downloads or HLS/M3U8 final save)
 */
async function cancelChromeDownloads(download: DownloadState): Promise<void> {
  // Only cancel if chromeDownloadId is set (Chrome downloads API is being used)
  // HLS/M3U8 downloads only use Chrome API at the final save stage
  if (download.chromeDownloadId === undefined) {
    logger.debug(
      `Skipping Chrome download cancellation - Chrome API not used for this download`,
    );
    return;
  }

  return new Promise((resolve) => {
    chrome.downloads.cancel(download.chromeDownloadId!, () => {
      if (chrome.runtime.lastError) {
        logger.debug(
          `Failed to cancel Chrome download ${download.chromeDownloadId}:`,
          chrome.runtime.lastError.message,
        );
      } else {
        logger.info(`Cancelled Chrome download ${download.chromeDownloadId}`);
      }
      resolve();
    });
  });
}

function resolveFilename(
  url: string,
  metadata: VideoMetadata,
  filename?: string,
  tabTitle?: string,
  website?: string,
): string {
  if (filename) return filename;
  const extension =
    metadata.format === VideoFormat.HLS ||
    metadata.format === VideoFormat.M3U8 ||
    metadata.format === VideoFormat.DASH
      ? "mp4"
      : metadata.fileExtension || "mp4";
  return tabTitle || website
    ? generateFilenameFromTabInfo(tabTitle, website, extension)
    : generateFilenameWithExtension(url, extension);
}

/**
 * Execute download using download manager
 * Sends completion or failure notifications to popup
 */
async function startDownload(
  downloadManager: DownloadManager,
  url: string,
  filename: string | undefined,
  metadata: VideoMetadata,
  tabTitle?: string,
  website?: string,
  manifestQuality?: {
    videoPlaylistUrl?: string | null;
    audioPlaylistUrl?: string | null;
    selectedBandwidth?: number;
  },
  isManual?: boolean,
  abortSignal?: AbortSignal,
): Promise<void> {
  try {
    const finalFilename = resolveFilename(url, metadata, filename, tabTitle, website);

    const downloadState = await downloadManager.download(
      url,
      finalFilename,
      metadata,
      manifestQuality,
      isManual,
      abortSignal,
    );

    // Handle failed downloads (e.g., unknown format)
    if (isDownloadFailed(downloadState)) {
      const errorMessage = downloadState.progress.error || "Download failed";
      sendDownloadFailed(url, errorMessage);
      return;
    }

    // Handle successful downloads
    sendDownloadComplete(downloadState.id);
  } catch (error) {
    logger.error(`Download process failed for ${url}:`, error);

    const errorMessage = error instanceof Error ? error.message : String(error);

    sendDownloadFailed(url, errorMessage);
    throw error;
  }
}

/**
 * Stop an active HLS/M3U8 download and save whatever segments have been downloaded so far
 */
async function handleStopAndSaveMessage(payload: {
  url: string;
}): Promise<{ success: boolean; error?: string }> {
  try {
    const normalizedUrl = normalizeUrl(payload.url);
    const controller = downloadAbortControllers.get(normalizedUrl);
    if (!controller) {
      return {
        success: false,
        error: "No active download found for this URL.",
      };
    }
    savePartialDownloads.add(normalizedUrl);
    controller.abort();
    logger.info(`Stop-and-save triggered for ${normalizedUrl}`);
    return { success: true };
  } catch (error) {
    logger.error("Stop-and-save error:", error);
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Cancel active download
 * Removes from active downloads map, cancels Chrome downloads, and deletes the download
 * This resets the UI to initial state (video card shows as just detected)
 */
async function handleCancelDownload(id: string): Promise<void> {
  const download = await getDownload(id);
  if (!download) {
    return;
  }

  // Prevent cancellation during merging or saving phases
  // Chunks are already downloaded at this point, so cancellation would waste resources
  if (!canCancelDownload(download.progress.stage)) {
    logger.info(
      `Cancellation prevented for download ${id}: ${CANNOT_CANCEL_MESSAGE}`,
    );
    throw new Error(CANNOT_CANCEL_MESSAGE);
  }

  const normalizedUrl = normalizeUrl(download.url);

  // 1. Abort fetch operations
  const abortController = downloadAbortControllers.get(normalizedUrl);
  if (abortController) {
    abortController.abort();
    logger.info(`Aborted fetch operations for download ${normalizedUrl}`);
    downloadAbortControllers.delete(normalizedUrl);
  }

  // 2. Cancel Chrome downloads
  await cancelChromeDownloads(download);

  // 3. Clean up chunks for HLS/M3U8/DASH downloads
  // Only cleanup if format uses IndexedDB chunks
  if (
    download.metadata.format === VideoFormat.HLS ||
    download.metadata.format === VideoFormat.M3U8 ||
    download.metadata.format === VideoFormat.DASH
  ) {
    try {
      await deleteChunks(download.id);
      logger.info(`Cleaned up chunks for cancelled download ${download.id}`);
    } catch (error) {
      logger.error(
        `Failed to clean up chunks for download ${download.id}:`,
        error,
      );
      // Don't throw - continue with cancellation even if cleanup fails
    }
  }

  // 4. Delete the download from database to reset UI to initial state
  // This removes the download from the downloads list and shows the video card
  // in the detected videos list as if it was just detected
  await deleteDownload(download.id);

  // Note: activeDownloads cleanup is handled in the promise's finally block
  // We don't remove it here to avoid race conditions - let the promise complete
  // and clean itself up. The abort signal will cause the download to stop.

  logger.info(`Download cancelled and removed: ${id}`);
}

/**
 * Start live HLS recording
 */
async function handleStartRecordingMessage(payload: {
  url: string;
  metadata: VideoMetadata;
  filename?: string;
  tabTitle?: string;
  website?: string;
  selectedBandwidth?: number;
}): Promise<{ success: boolean; error?: string }> {
  try {
    return await handleStartRecording(payload);
  } catch (error) {
    logger.error("Start recording error:", error);
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Start live HLS/DASH recording (core logic)
 */
async function handleStartRecording(payload: {
  url: string;
  metadata: VideoMetadata;
  filename?: string;
  tabTitle?: string;
  website?: string;
  selectedBandwidth?: number;
}): Promise<{ success: boolean; error?: string }> {
  const { url, metadata, filename, tabTitle, website } = payload;
  const normalizedUrl = normalizeUrl(url);

  // Clean up finished entry so re-recording starts fresh
  const existing = await getDownloadByUrl(normalizedUrl);
  if (
    existing &&
    (existing.progress.stage === DownloadStage.COMPLETED ||
      existing.progress.stage === DownloadStage.FAILED ||
      existing.progress.stage === DownloadStage.CANCELLED)
  ) {
    await deleteDownload(existing.id);
  }

  if (activeDownloads.has(normalizedUrl)) {
    return {
      success: false,
      error: "Recording already in progress for this URL.",
    };
  }

  const config = await loadSettings();
  const recordingHandlerOptions = {
    maxConcurrent: config.maxConcurrent,
    ffmpegTimeout: config.ffmpegTimeout,
    maxRetries: config.advanced.maxRetries,
    retryDelayMs: config.advanced.retryDelayMs,
    retryBackoffFactor: config.advanced.retryBackoffFactor,
    fragmentFailureRate: config.advanced.fragmentFailureRate,
    dbSyncIntervalMs: config.advanced.dbSyncIntervalMs,
    minPollIntervalMs: config.recording.minPollIntervalMs,
    maxPollIntervalMs: config.recording.maxPollIntervalMs,
    pollFraction: config.recording.pollFraction,
  };

  // Build initial download state
  const stateId = generateDownloadId(normalizedUrl);
  const initialState: DownloadState = {
    id: stateId,
    url,
    metadata,
    progress: {
      url,
      stage: DownloadStage.RECORDING,
      segmentsCollected: 0,
      message: "Recording...",
    },
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  await storeDownload(initialState);

  const abortController = new AbortController();
  downloadAbortControllers.set(normalizedUrl, abortController);

  const onProgress = async (state: DownloadState) => {
    const controller = downloadAbortControllers.get(normalizeUrl(state.url));
    // Allow progress updates through when in post-recording stages (MERGING, SAVING, COMPLETED)
    // since the abort signal is used to stop the recording loop, not to cancel the merge
    const isPostRecording =
      state.progress.stage === DownloadStage.MERGING ||
      state.progress.stage === DownloadStage.SAVING ||
      state.progress.stage === DownloadStage.COMPLETED;
    if (!isPostRecording && (!controller || controller.signal.aborted)) return;
    await storeDownload(state);
    try {
      chrome.runtime.sendMessage(
        {
          type: MessageType.DOWNLOAD_PROGRESS,
          payload: { id: state.id, progress: state.progress },
        },
        () => {
          if (chrome.runtime.lastError) {
          }
        },
      );
    } catch (_) {}
  };

  const handler =
    metadata.format === VideoFormat.DASH
      ? new DashRecordingHandler({
          onProgress,
          selectedBandwidth: payload.selectedBandwidth,
          ...recordingHandlerOptions,
        })
      : new HlsRecordingHandler({ onProgress, ...recordingHandlerOptions });

  const finalFilename = resolveFilename(url, metadata, filename, tabTitle, website);

  const recordingPromise = handler
    .record(
      url,
      finalFilename,
      stateId,
      abortController.signal,
      metadata.pageUrl,
    )
    .then(async () => {
      await cleanupDownloadResources(normalizedUrl);
      sendDownloadComplete(stateId);
      const cfg = await loadSettings();
      if (!cfg.historyEnabled) await deleteDownload(stateId);
    })
    .catch(async (error: unknown) => {
      // Persist FAILED state to IndexedDB so the downloads tab reflects the real status
      const failedState = await getDownload(stateId);
      if (
        failedState &&
        failedState.progress.stage !== DownloadStage.COMPLETED
      ) {
        failedState.progress.stage = DownloadStage.FAILED;
        failedState.progress.message =
          error instanceof Error ? error.message : String(error);
        failedState.updatedAt = Date.now();
        await storeDownload(failedState);
      }
      if (!(error instanceof CancellationError)) {
        logger.error(`Recording failed for ${url}:`, error);
        sendDownloadFailed(
          url,
          error instanceof Error ? error.message : String(error),
        );
      }
      await cleanupDownloadResources(normalizedUrl);
      const cfg = await loadSettings();
      if (!cfg.historyEnabled) await deleteDownload(stateId);
    })
    .finally(() => {
      activeDownloads.delete(normalizedUrl);
      if (activeDownloads.size === 0) {
        updateKeepAlive();
        closeOffscreenDocument().catch((err) =>
          logger.error("Failed to close offscreen document:", err),
        );
      }
    });

  activeDownloads.set(normalizedUrl, recordingPromise);
  if (activeDownloads.size === 1) {
    updateKeepAlive();
    // Pre-warm FFmpeg — recordings always need FFmpeg for the merge phase
    createOffscreenDocument()
      .then(() =>
        chrome.runtime.sendMessage({ type: MessageType.WARMUP_FFMPEG }),
      )
      .catch((err) =>
        logger.error("FFmpeg pre-warm failed for recording:", err),
      );
  }

  return { success: true };
}

/**
 * Stop live HLS recording (triggers merge + save inside handler)
 */
async function handleStopRecordingMessage(payload: {
  url: string;
}): Promise<{ success: boolean; error?: string }> {
  try {
    const normalizedUrl = normalizeUrl(payload.url);
    const abortController = downloadAbortControllers.get(normalizedUrl);
    if (!abortController) {
      return {
        success: false,
        error: "No active recording found for this URL.",
      };
    }
    abortController.abort();
    logger.info(`Stopped recording for ${normalizedUrl}`);
    return { success: true };
  } catch (error) {
    logger.error("Stop recording error:", error);
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Set extension icon to blue
 */
async function handleSetIconBlue(tabId?: number): Promise<void> {
  try {
    const iconPaths = {
      16: "icons/icon-16.png",
      48: "icons/icon-48.png",
      128: "icons/icon-128.png",
    };

    if (tabId) {
      // Set icon for specific tab
      await chrome.action.setIcon({
        tabId,
        path: iconPaths,
      });
    } else {
      // Set icon globally
      await chrome.action.setIcon({
        path: iconPaths,
      });
    }
  } catch (error) {
    logger.error("Failed to set blue icon:", error);
  }
}

/**
 * Set extension icon to gray
 */
async function handleSetIconGray(tabId?: number): Promise<void> {
  try {
    const iconPaths = {
      16: "icons/icon-gray-16.png",
      48: "icons/icon-gray-48.png",
      128: "icons/icon-gray-128.png",
    };

    if (tabId) {
      // Set icon for specific tab
      await chrome.action.setIcon({
        tabId,
        path: iconPaths,
      });
    } else {
      // Set icon globally
      await chrome.action.setIcon({
        path: iconPaths,
      });
    }
  } catch (error) {
    logger.error("Failed to set gray icon:", error);
  }
}

// Initialize service worker
init().catch((error) => {
  logger.error("Service worker initialization failed:", error);
});
