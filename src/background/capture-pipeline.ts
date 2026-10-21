/**
 * Service-worker side of MediaSource stream capture.
 *
 * CAPTURE_PREPARE (from a content script) allocates a downloadId and a one-time
 * token and creates the DownloadState so progress shows up in the popup.
 * CAPTURE_FINALIZE (from the capture bridge page, after it wrote the chunks to
 * IndexedDB) validates the token and runs the DASH mux path in the offscreen
 * document — captured MSE data is fragmented MP4/WebM, exactly what that path
 * already handles — then saves the result.
 */

import { DownloadStage, DownloadState, VideoFormat } from "../core/types";
import { MessageType } from "../shared/messages";
import { storeDownload, getDownload } from "../core/database/downloads";
import { deleteChunks } from "../core/database/chunks";
import { processWithFFmpeg } from "../core/ffmpeg/ffmpeg-bridge";
import { saveBlobUrlToFile } from "../core/utils/blob-utils";
import { generateFilenameFromTabInfo } from "../core/utils/file-utils";
import { loadSettings } from "../core/storage/settings";
import { logger } from "../core/utils/logger";
import { SAVING_STAGE_PERCENTAGE } from "../shared/constants";

const PENDING_TTL_MS = 15 * 60_000;

type Container = "mp4" | "webm" | "mkv";

interface PendingCapture {
  token: string;
  downloadId: string;
  container: Container;
  filenameBase: string;
  createdAt: number;
}

export interface CapturePipelineDeps {
  /** Called when a capture starts/stops so the SW can keep itself alive */
  setActive: (downloadId: string, active: boolean) => void;
  onCompleted: (downloadId: string) => void;
}

const pending = new Map<string, PendingCapture>();
let deps: CapturePipelineDeps | null = null;

export function initCapturePipeline(d: CapturePipelineDeps): void {
  deps = d;
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

function expireStale(): void {
  const now = Date.now();
  for (const [token, p] of pending) {
    if (now - p.createdAt > PENDING_TTL_MS) {
      pending.delete(token);
      deps?.setActive(p.downloadId, false);
      deleteChunks(p.downloadId).catch(() => {});
      deleteChunks(`${p.downloadId}_a`).catch(() => {});
      updateState(p.downloadId, {
        stage: DownloadStage.FAILED,
        error: "Capture transfer timed out",
        message: "Capture transfer timed out",
      }).catch(() => {});
    }
  }
}

export async function handleCapturePrepare(
  payload: { title?: string; pageUrl?: string; website?: string; container?: Container; hasAudio?: boolean },
  sender: chrome.runtime.MessageSender,
): Promise<{ success: boolean; token?: string; downloadId?: string; error?: string }> {
  expireStale();
  if (!sender.tab?.id) return { success: false, error: "Capture must come from a tab" };

  const container: Container = payload.container === "webm" || payload.container === "mkv" ? payload.container : "mp4";
  const token = crypto.randomUUID();
  const downloadId = `cap_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  const pageUrl = payload.pageUrl || sender.url || "";
  const title = (payload.title || "").trim() || "Captured stream";
  const filenameBase = generateFilenameFromTabInfo(title, payload.website, container).replace(/\.[a-z0-9]+$/i, "");

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

  pending.set(token, { token, downloadId, container, filenameBase, createdAt: now });
  deps?.setActive(downloadId, true);
  return { success: true, token, downloadId };
}

export async function handleCaptureFinalize(
  payload: { token?: string; downloadId?: string; videoLength?: number; audioLength?: number },
  sender: chrome.runtime.MessageSender,
): Promise<{ success: boolean; error?: string }> {
  // Only the extension's own bridge page may finalize.
  const bridgePrefix = chrome.runtime.getURL("capture-bridge/");
  if (sender.id !== chrome.runtime.id || !sender.url?.startsWith(bridgePrefix)) {
    return { success: false, error: "Unauthorized" };
  }
  const p = payload.token ? pending.get(payload.token) : undefined;
  if (!p || p.downloadId !== payload.downloadId) {
    return { success: false, error: "Unknown or expired capture" };
  }
  pending.delete(p.token);

  const videoLength = Math.max(0, Math.floor(payload.videoLength ?? 0));
  const audioLength = Math.max(0, Math.floor(payload.audioLength ?? 0));
  if (videoLength === 0) {
    deps?.setActive(p.downloadId, false);
    await updateState(p.downloadId, { stage: DownloadStage.FAILED, error: "Nothing captured", message: "Nothing captured" });
    return { success: false, error: "Nothing captured" };
  }

  // Mux in the background; the bridge only needs to know the hand-off succeeded.
  void muxAndSave(p, videoLength, audioLength);
  return { success: true };
}

async function muxAndSave(p: PendingCapture, videoLength: number, audioLength: number): Promise<void> {
  const { downloadId } = p;
  const audioId = `${downloadId}_a`;
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
    await deleteChunks(downloadId).catch(() => {});
    await deleteChunks(audioId).catch(() => {});
  }
}
