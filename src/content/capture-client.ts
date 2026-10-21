/**
 * Isolated-world side of MediaSource stream capture.
 *
 * Talks to the MAIN-world hook (`src/inject/mse-capture.ts`) over window.postMessage,
 * answers popup status/command messages for this frame, and hands captured
 * buffers to the extension:
 *
 *   page hook --postMessage(transfer)--> content script
 *     --MessageChannel(transfer)--> capture bridge iframe (extension origin)
 *     --IndexedDB chunks + CAPTURE_FINALIZE--> service worker --> offscreen FFmpeg
 *
 * The bridge iframe is needed because chrome.runtime messaging JSON-serializes
 * payloads, which is far too slow for hundreds of MB of media. If the bridge
 * fails (e.g. the page blocks the frame), tracks are saved unmuxed directly
 * from the page as a fallback so the capture is never lost.
 */

import {
  MessageType,
  CaptureAction,
  CaptureFrameStatus,
  CaptureSessionStatus,
} from "../shared/messages";
import { CAPTURE_CHANNEL } from "../shared/constants";
import { logger } from "../core/utils/logger";

const BRIDGE_CHANNEL = "__media_bridge_bridge__";
const BRIDGE_LOAD_TIMEOUT_MS = 10_000;
const EXPORT_TIMEOUT_MS = 30_000;

interface ExportedTrack {
  kind: "video" | "audio" | "unknown";
  mime: string;
  container: "mp4" | "webm" | "unknown";
  chunks: ArrayBuffer[];
}

interface PageStatus {
  armed: boolean;
  limitReached: boolean;
  sessions: CaptureSessionStatus[];
}

type StatusListener = (status: PageStatus) => void;

let lastStatus: PageStatus = { armed: false, limitReached: false, sessions: [] };
let saving = false;
const listeners = new Set<StatusListener>();
const pendingExports = new Map<
  string,
  { resolve: (tracks: ExportedTrack[]) => void; reject: (e: Error) => void }
>();

function postToPage(msg: Record<string, unknown>): void {
  window.postMessage({ channel: CAPTURE_CHANNEL, dir: "to-page", ...msg }, "*");
}

export function getCaptureStatus(): PageStatus {
  return lastStatus;
}

export function isCaptureSaving(): boolean {
  return saving;
}

export function onCaptureStatus(listener: StatusListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getFrameStatus(frameId: number): CaptureFrameStatus {
  return {
    frameId,
    armed: lastStatus.armed,
    limitReached: lastStatus.limitReached,
    saving,
    sessions: lastStatus.sessions,
    title: document.title,
    pageUrl: location.href,
  };
}

/** Find the capture session feeding a given media element (by duration/size heuristics). */
export function sessionForElement(el: HTMLMediaElement): CaptureSessionStatus | undefined {
  if (!el.currentSrc?.startsWith("blob:") && !el.src?.startsWith("blob:")) return undefined;
  const sessions = lastStatus.sessions;
  if (sessions.length <= 1) return sessions[0];
  const v = el as HTMLVideoElement;
  return (
    sessions.find(
      (s) => s.width === v.videoWidth && s.height === v.videoHeight && s.duration === el.duration,
    ) ?? sessions.reduce((a, b) => (b.bytes > a.bytes ? b : a))
  );
}

export function runCaptureAction(action: CaptureAction, sessionId?: number): Promise<{ success: boolean; error?: string }> {
  switch (action) {
    case "start":
      postToPage({ cmd: "arm" });
      return Promise.resolve({ success: true });
    case "boost":
      postToPage({ cmd: "boost", sessionId });
      return Promise.resolve({ success: true });
    case "discard":
      postToPage({ cmd: "disarm" });
      postToPage({ cmd: "discard" });
      return Promise.resolve({ success: true });
    case "stop-save":
      return saveCapture(sessionId);
  }
}

function requestExport(sessionId?: number): Promise<ExportedTrack[]> {
  const reqId = `${Date.now()}_${Math.random().toString(36).slice(2)}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingExports.delete(reqId);
      reject(new Error("Timed out waiting for the page to hand over captured data"));
    }, EXPORT_TIMEOUT_MS);
    pendingExports.set(reqId, {
      resolve: (t) => {
        clearTimeout(timer);
        resolve(t);
      },
      reject: (e) => {
        clearTimeout(timer);
        reject(e);
      },
    });
    postToPage({ cmd: "export", sessionId, reqId });
  });
}

/** Pick one video and one audio track; a single track may contain both (muxed). */
function selectTracks(tracks: ExportedTrack[]): { video?: ExportedTrack; audio?: ExportedTrack } {
  const video = tracks.find((t) => t.kind === "video") ?? tracks.find((t) => t.kind === "unknown");
  const audio = tracks.find((t) => t.kind === "audio");
  if (!video && audio) return { video: audio };
  return { video, audio };
}

function outputContainer(video?: ExportedTrack, audio?: ExportedTrack): "mp4" | "webm" | "mkv" {
  const containers = [video?.container, audio?.container].filter(Boolean);
  if (containers.every((c) => c === "mp4")) return "mp4";
  if (containers.every((c) => c === "webm")) return "webm";
  return "mkv";
}

async function saveCapture(sessionId?: number): Promise<{ success: boolean; error?: string }> {
  if (saving) return { success: false, error: "A capture is already being saved" };
  saving = true;
  notify();
  try {
    const tracks = await requestExport(sessionId);
    const { video, audio } = selectTracks(tracks);
    if (!video) return { success: false, error: "No media was captured" };

    const container = outputContainer(video, audio);
    try {
      await transferViaBridge(video, audio, container);
      return { success: true };
    } catch (error) {
      logger.warn("[Media Bridge] Capture bridge failed, saving raw tracks:", error);
      saveRawTracks([video, audio].filter(Boolean) as ExportedTrack[]);
      return {
        success: true,
        error: "Saved as separate video/audio files (merge step unavailable on this page)",
      };
    }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  } finally {
    saving = false;
    notify();
  }
}

function sendRuntimeMessage<T>(message: unknown): Promise<T> {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(response as T);
    });
  });
}

async function transferViaBridge(
  video: ExportedTrack,
  audio: ExportedTrack | undefined,
  container: "mp4" | "webm" | "mkv",
): Promise<void> {
  const prep = await sendRuntimeMessage<{ success: boolean; token?: string; downloadId?: string; error?: string }>({
    type: MessageType.CAPTURE_PREPARE,
    payload: {
      title: document.title,
      pageUrl: location.href,
      website: location.hostname.replace(/^www\./, ""),
      container,
      hasAudio: !!audio,
    },
  });
  if (!prep?.success || !prep.token || !prep.downloadId) {
    throw new Error(prep?.error || "Service worker refused capture");
  }

  const bridgeUrl = chrome.runtime.getURL("capture-bridge/bridge.html");
  const bridgeOrigin = new URL(bridgeUrl).origin;
  const iframe = document.createElement("iframe");
  iframe.src = bridgeUrl;
  iframe.setAttribute("aria-hidden", "true");
  iframe.style.cssText =
    "position:fixed!important;width:0!important;height:0!important;border:0!important;opacity:0!important;pointer-events:none!important;";

  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Capture bridge did not load")), BRIDGE_LOAD_TIMEOUT_MS);
      iframe.addEventListener("load", () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
      (document.body || document.documentElement).appendChild(iframe);
    });

    const channel = new MessageChannel();
    const result = new Promise<void>((resolve, reject) => {
      channel.port1.onmessage = (event) => {
        const m = event.data;
        if (m?.type === "result") {
          if (m.success) resolve();
          else reject(new Error(m.error || "Capture bridge failed"));
        }
      };
    });

    iframe.contentWindow!.postMessage(
      { channel: BRIDGE_CHANNEL, token: prep.token, downloadId: prep.downloadId },
      bridgeOrigin,
      [channel.port2],
    );

    const send = (slot: "video" | "audio", track: ExportedTrack) => {
      track.chunks.forEach((data, index) => {
        channel.port1.postMessage({ type: "chunk", slot, index, data }, [data]);
      });
    };
    send("video", video);
    if (audio) send("audio", audio);
    channel.port1.postMessage({
      type: "done",
      videoLength: video.chunks.length,
      audioLength: audio?.chunks.length ?? 0,
    });

    await result;
  } finally {
    iframe.remove();
  }
}

/**
 * Last-resort save: each track as its own file via a page-origin blob URL.
 * Only reached when buffers were not transferred (bridge failed before sending).
 */
function saveRawTracks(tracks: ExportedTrack[]): void {
  const base = (document.title || "capture").replace(/[\\/:*?"<>|]+/g, "_").slice(0, 120);
  for (const t of tracks) {
    if (t.chunks.some((c) => c.byteLength === 0)) continue; // detached by a partial transfer
    const ext = t.container === "webm" ? "webm" : t.kind === "audio" ? "m4a" : "mp4";
    const blob = new Blob(t.chunks, { type: t.mime.split(";")[0] || "application/octet-stream" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${base} (${t.kind}).${ext}`;
    a.style.display = "none";
    document.documentElement.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }
}

function notify(): void {
  for (const l of listeners) {
    try {
      l(lastStatus);
    } catch {
      // ignore listener errors
    }
  }
}

/**
 * Wire up page <-> content messaging and popup handlers. Call once per frame.
 */
export function initCaptureClient(options: { maxBytes: number; autoArm: boolean }): void {
  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const msg = event.data;
    if (!msg || msg.channel !== CAPTURE_CHANNEL || msg.dir !== "to-content") return;

    if (msg.evt === "status" && msg.status) {
      lastStatus = msg.status as PageStatus;
      notify();
    } else if (msg.evt === "export-result" && typeof msg.reqId === "string") {
      const pending = pendingExports.get(msg.reqId);
      if (!pending) return;
      pendingExports.delete(msg.reqId);
      if (msg.error) pending.reject(new Error(msg.error));
      else pending.resolve(msg.tracks as ExportedTrack[]);
    }
  });

  postToPage({ cmd: "config", maxBytes: options.maxBytes, autoArm: options.autoArm });
  postToPage({ cmd: "status" });

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (sender.id !== chrome.runtime.id) return false;
    if (message?.type === MessageType.CAPTURE_GET_STATUS) {
      sendResponse(getFrameStatus(message.payload?.frameId ?? 0));
      return false;
    }
    if (message?.type === MessageType.CAPTURE_COMMAND) {
      runCaptureAction(message.payload.action as CaptureAction, message.payload.sessionId).then(sendResponse);
      return true;
    }
    return false;
  });
}

export function updateCaptureConfig(options: { maxBytes: number }): void {
  postToPage({ cmd: "config", maxBytes: options.maxBytes });
}
