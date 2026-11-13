/**
 * Service-worker side of MediaSource stream capture.
 *
 * Lifecycle of one capture (keyed by a one-time token):
 *
 *   CAPTURE_PREPARE   content script -> SW. Allocates a `cap_` downloadId and a
 *                     token, creates the DownloadState. Must be claimed within
 *                     CAPTURE_CLAIM_TIMEOUT_MS.
 *   CAPTURE_CLAIM     bridge page -> SW. Validates the token BEFORE the bridge
 *                     writes anything and returns the byte budget. A token can
 *                     be claimed once.
 *   CAPTURE_HEARTBEAT bridge page -> SW while chunks are being written; the
 *                     capture is abandoned after CAPTURE_IDLE_TIMEOUT_MS of silence.
 *   CAPTURE_FINALIZE  bridge page -> SW. Checks the stored chunk counts and
 *                     runs the DASH mux path in the offscreen document (captured
 *                     MSE data is fragmented MP4/WebM, which that path handles).
 *   CAPTURE_ABORT     content script (own tab) or bridge -> SW. Fails the
 *                     download and deletes its chunks.
 *
 * Every exit path (abort, timeout, tab closed, mux failure) clears the pending
 * entry, the keep-alive and the `cap_*` chunks. Captures interrupted by a
 * service worker restart are cleaned up by `cleanupStaleCaptures()` at startup.
 */

import { DownloadStage, DownloadState, VideoFormat } from "../core/types";
import { MessageType } from "../shared/messages";
import { storeDownload, getDownload, getAllDownloads } from "../core/database/downloads";
import { deleteChunks, getChunkCount } from "../core/database/chunks";
import { processWithFFmpeg } from "../core/ffmpeg/ffmpeg-bridge";
import { saveBlobUrlToFile } from "../core/utils/blob-utils";
import { generateFilenameFromTabInfo } from "../core/utils/file-utils";
import { loadSettings } from "../core/storage/settings";
import { logger } from "../core/utils/logger";
import {
  SAVING_STAGE_PERCENTAGE,
  CAPTURE_CLAIM_TIMEOUT_MS,
  CAPTURE_IDLE_TIMEOUT_MS,
  CAPTURE_BYTES_MARGIN,
  CAPTURE_MAX_CHUNKS_PER_TRACK,
} from "../shared/constants";

export const CAPTURE_ID_PREFIX = "cap_";
const CAPTURE_ID_PATTERN = /^cap_[a-z0-9_]{1,64}$/;

type Container = "mp4" | "webm" | "mkv";

interface PendingCapture {
  token: string;
  downloadId: string;
  tabId: number;
  container: Container;
  filenameBase: string;
  maxBytes: number;
  claimed: boolean;
  timer: ReturnType<typeof setTimeout>;
}

export interface CapturePipelineDeps {
  /** Called when a capture starts/stops so the SW can keep itself alive */
  setActive: (downloadId: string, active: boolean) => void;
  onCompleted: (downloadId: string) => void;
}

type Result = { success: boolean; error?: string };

const pending = new Map<string, PendingCapture>();
let deps: CapturePipelineDeps | null = null;

export function isCaptureId(id: string): boolean {
  return CAPTURE_ID_PATTERN.test(id);
}

function audioIdFor(downloadId: string): string {
  return `${downloadId}_a`;
}

function isBridgeSender(sender: chrome.runtime.MessageSender): boolean {
  return (
    sender.id === chrome.runtime.id &&
    !!sender.url?.startsWith(chrome.runtime.getURL("capture-bridge/bridge.html"))
  );
}

function broadcast(state: DownloadState): void {
  chrome.runtime.sendMessage(
    { type: MessageType.DOWNLOAD_PROGRESS, payload: { id: state.id, progress: state.progress } },
    () => void chrome.runtime.lastError,
  );
}

async function updateState(
  id: string,
  patch: Partial<DownloadState["progress"]>,
  extra: Partial<DownloadState> = {},
): Promise<void> {
  const state = await getDownload(id);
  if (!state) return;
  Object.assign(state.progress, patch);
  Object.assign(state, extra);
  state.updatedAt = Date.now();
  await storeDownload(state);
  broadcast(state);
}

async function deleteCaptureChunks(downloadId: string): Promise<void> {
  await Promise.all([
    deleteChunks(downloadId).catch(() => {}),
    deleteChunks(audioIdFor(downloadId)).catch(() => {}),
  ]);
}

function armTimer(p: PendingCapture, ms: number, reason: string): void {
  clearTimeout(p.timer);
  p.timer = setTimeout(() => {
    void failPending(p.token, reason);
  }, ms);
}

/** Drop a pending capture, mark it failed and delete whatever it wrote. */
async function failPending(token: string, reason: string): Promise<boolean> {
  const p = pending.get(token);
  if (!p) return false;
  pending.delete(token);
  clearTimeout(p.timer);
  logger.warn(`Capture ${p.downloadId} abandoned: ${reason}`);
  try {
    await deleteCaptureChunks(p.downloadId);
    await updateState(p.downloadId, { stage: DownloadStage.FAILED, error: reason, message: reason });
  } finally {
    deps?.setActive(p.downloadId, false);
  }
  return true;
}

export function initCapturePipeline(d: CapturePipelineDeps): void {
  deps = d;
  // The bridge iframe lives inside the tab; if the tab goes away mid-transfer
  // there will never be a finalize.
  chrome.tabs.onRemoved.addListener((tabId) => {
    for (const p of [...pending.values()]) {
      if (p.tabId === tabId) void failPending(p.token, "Tab closed before the capture was saved");
    }
  });
}

/**
 * Startup cleanup: pending captures only live in memory, so any capture that is
 * still mid-flight in the database was interrupted by a service worker restart.
 */
export async function cleanupStaleCaptures(): Promise<void> {
  const downloads = await getAllDownloads();
  const stale = downloads.filter(
    (d) =>
      isCaptureId(d.id) &&
      d.progress.stage !== DownloadStage.COMPLETED &&
      d.progress.stage !== DownloadStage.FAILED &&
      d.progress.stage !== DownloadStage.CANCELLED,
  );
  for (const d of stale) {
    await deleteCaptureChunks(d.id);
    d.progress.stage = DownloadStage.FAILED;
    d.progress.error = "Capture was interrupted";
    d.progress.message = "Capture was interrupted";
    d.updatedAt = Date.now();
    await storeDownload(d);
  }
  if (stale.length > 0) logger.info(`Cleaned up ${stale.length} interrupted capture(s)`);
}

export async function handleCapturePrepare(
  payload: { title?: unknown; pageUrl?: unknown; website?: unknown; container?: unknown },
  sender: chrome.runtime.MessageSender,
): Promise<{ success: boolean; token?: string; downloadId?: string; error?: string }> {
  const tabId = sender.tab?.id;
  if (tabId === undefined || sender.id !== chrome.runtime.id) {
    return { success: false, error: "Capture must come from a tab" };
  }
  const { capture } = await loadSettings();
  if (!capture.enabled) return { success: false, error: "Stream capture is disabled in settings" };

  const container: Container =
    payload.container === "webm" || payload.container === "mkv" ? payload.container : "mp4";
  const token = crypto.randomUUID();
  const downloadId = `${CAPTURE_ID_PREFIX}${Date.now()}_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
  const pageUrl = typeof payload.pageUrl === "string" ? payload.pageUrl : sender.url || "";
  const title = (typeof payload.title === "string" ? payload.title : "").trim().slice(0, 300) || "Captured stream";
  const website = typeof payload.website === "string" ? payload.website.slice(0, 200) : undefined;
  const filenameBase = generateFilenameFromTabInfo(title, website, container).replace(/\.[a-z0-9]+$/i, "");

  const now = Date.now();
  const state: DownloadState = {
    id: downloadId,
    // Unique per capture so it never collides with a URL-keyed download of the same page
    url: `${pageUrl.split("#")[0]}#media-bridge-capture-${downloadId}`,
    metadata: {
      url: pageUrl,
      format: VideoFormat.CAPTURE,
      pageUrl,
      title,
      fileExtension: container,
    },
    progress: {
      url: pageUrl,
      stage: DownloadStage.DOWNLOADING,
      message: "Transferring captured stream…",
      percentage: 5,
    },
    createdAt: now,
    updatedAt: now,
  };
  await storeDownload(state);
  broadcast(state);

  const p: PendingCapture = {
    token,
    downloadId,
    tabId,
    container,
    filenameBase,
    maxBytes: capture.maxMb * 1024 * 1024 + CAPTURE_BYTES_MARGIN,
    claimed: false,
    timer: undefined as unknown as ReturnType<typeof setTimeout>,
  };
  pending.set(token, p);
  armTimer(p, CAPTURE_CLAIM_TIMEOUT_MS, "Capture transfer never started");
  deps?.setActive(downloadId, true);
  return { success: true, token, downloadId };
}

/** Bridge asks to start writing. Nothing is written to IndexedDB before this succeeds. */
export function handleCaptureClaim(
  payload: { token?: unknown; downloadId?: unknown },
  sender: chrome.runtime.MessageSender,
): { success: boolean; maxBytes?: number; maxChunks?: number; error?: string } {
  if (!isBridgeSender(sender)) return { success: false, error: "Unauthorized" };
  const p = typeof payload.token === "string" ? pending.get(payload.token) : undefined;
  if (!p || p.claimed || p.downloadId !== payload.downloadId) {
    return { success: false, error: "Unknown or expired capture" };
  }
  p.claimed = true;
  armTimer(p, CAPTURE_IDLE_TIMEOUT_MS, "Capture transfer stalled");
  return { success: true, maxBytes: p.maxBytes, maxChunks: CAPTURE_MAX_CHUNKS_PER_TRACK };
}

export function handleCaptureHeartbeat(
  payload: { token?: unknown },
  sender: chrome.runtime.MessageSender,
): Result {
  if (!isBridgeSender(sender)) return { success: false, error: "Unauthorized" };
  const p = typeof payload.token === "string" ? pending.get(payload.token) : undefined;
  if (!p || !p.claimed) return { success: false, error: "Unknown or expired capture" };
  armTimer(p, CAPTURE_IDLE_TIMEOUT_MS, "Capture transfer stalled");
  return { success: true };
}

/** Abort from the bridge, or from the content script of the tab that prepared the capture. */
export async function handleCaptureAbort(
  payload: { token?: unknown; reason?: unknown },
  sender: chrome.runtime.MessageSender,
): Promise<Result> {
  const p = typeof payload.token === "string" ? pending.get(payload.token) : undefined;
  if (!p) return { success: false, error: "Unknown or expired capture" };
  const fromOwnTab = sender.id === chrome.runtime.id && sender.tab?.id === p.tabId && !isBridgeSender(sender);
  if (!fromOwnTab && !isBridgeSender(sender)) return { success: false, error: "Unauthorized" };
  const reason =
    typeof payload.reason === "string" && payload.reason ? payload.reason.slice(0, 300) : "Capture transfer failed";
  await failPending(p.token, reason);
  return { success: true };
}

export async function handleCaptureFinalize(
  payload: { token?: unknown; downloadId?: unknown; videoLength?: unknown; audioLength?: unknown },
  sender: chrome.runtime.MessageSender,
): Promise<Result> {
  if (!isBridgeSender(sender)) return { success: false, error: "Unauthorized" };
  const p = typeof payload.token === "string" ? pending.get(payload.token) : undefined;
  if (!p || !p.claimed || p.downloadId !== payload.downloadId) {
    return { success: false, error: "Unknown or expired capture" };
  }

  const videoLength = Number(payload.videoLength);
  const audioLength = Number(payload.audioLength);
  const valid = (n: number) => Number.isInteger(n) && n >= 0 && n <= CAPTURE_MAX_CHUNKS_PER_TRACK;
  if (!valid(videoLength) || !valid(audioLength) || videoLength === 0) {
    await failPending(p.token, videoLength === 0 ? "Nothing captured" : "Invalid capture");
    return { success: false, error: videoLength === 0 ? "Nothing captured" : "Invalid capture" };
  }

  // The bridge counted what it wrote; make sure the database agrees before muxing.
  const [storedVideo, storedAudio] = await Promise.all([
    getChunkCount(p.downloadId),
    audioLength > 0 ? getChunkCount(audioIdFor(p.downloadId)) : Promise.resolve(0),
  ]);
  if (storedVideo !== videoLength || storedAudio !== audioLength) {
    const reason = "Captured data was not fully stored";
    await failPending(p.token, reason);
    return { success: false, error: reason };
  }

  pending.delete(p.token);
  clearTimeout(p.timer);
  // Mux in the background; the bridge only needs to know the hand-off succeeded.
  void muxAndSave(p, videoLength, audioLength);
  return { success: true };
}

async function muxAndSave(p: PendingCapture, videoLength: number, audioLength: number): Promise<void> {
  const { downloadId } = p;
  const audioId = audioIdFor(downloadId);
  try {
    const { ffmpegTimeout } = await loadSettings();
    await updateState(downloadId, { stage: DownloadStage.MERGING, message: "Merging captured stream…", percentage: 0 });

    const { blobUrl, warning } = await processWithFFmpeg({
      requestType: MessageType.OFFSCREEN_PROCESS_DASH,
      responseType: MessageType.OFFSCREEN_PROCESS_DASH_RESPONSE,
      downloadId,
      payload: {
        videoLength,
        audioLength,
        audioDownloadId: audioLength > 0 ? audioId : undefined,
        container: p.container,
      },
      filename: p.filenameBase,
      timeout: ffmpegTimeout,
      onProgress: (progress, message) => {
        updateState(downloadId, {
          stage: DownloadStage.MERGING,
          percentage: Math.round(progress * 100),
          message: message || "Merging captured stream…",
        }).catch(() => {});
      },
    });

    await updateState(downloadId, { stage: DownloadStage.SAVING, message: "Saving file...", percentage: SAVING_STAGE_PERCENTAGE });
    const filePath = await saveBlobUrlToFile(blobUrl, `${p.filenameBase}.${p.container}`, downloadId);
    await updateState(
      downloadId,
      {
        stage: DownloadStage.COMPLETED,
        percentage: 100,
        message: warning ? `Capture saved — ${warning}` : "Capture saved",
      },
      { localPath: filePath },
    );
    chrome.runtime.sendMessage(
      { type: MessageType.DOWNLOAD_COMPLETE, payload: { id: downloadId } },
      () => void chrome.runtime.lastError,
    );
    deps?.onCompleted(downloadId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error("Capture mux failed:", error);
    await updateState(downloadId, { stage: DownloadStage.FAILED, error: message, message: `Capture failed: ${message}` });
  } finally {
    deps?.setActive(downloadId, false);
    await deleteCaptureChunks(downloadId);
  }
}
