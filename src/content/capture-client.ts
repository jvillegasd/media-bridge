/**
 * Isolated-world side of MediaSource stream capture.
 *
 * Talks to the MAIN-world hook (`src/inject/mse-capture.ts`) over window.postMessage,
 * answers popup status/command messages for this frame, and hands captured
 * buffers to the extension:
 *
 *   page hook --postMessage(transfer)--> content script
 *     --MessageChannel (copied, acked)--> capture bridge iframe (extension origin)
 *     --IndexedDB chunks + CAPTURE_FINALIZE--> service worker --> offscreen FFmpeg
 *
 * Everything that arrives on the window message bus may have been sent by the
 * page, so status and exported tracks are validated and coerced here, and the
 * memory cap is enforced from this side (the page cannot configure it).
 *
 * Chunks are copied to the bridge (not transferred) with a bounded number in
 * flight, so this script still owns every buffer until the bridge reports the
 * result. If the bridge fails, the service worker is told to abort and the
 * tracks are saved unmuxed straight from the page; success is only reported
 * when something was actually saved.
 */

import {
  MessageType,
  CaptureAction,
  CaptureFrameStatus,
  CaptureSessionStatus,
  CaptureTrackStatus,
} from "../shared/messages";
import { CAPTURE_CHANNEL, CAPTURE_BRIDGE_CHANNEL, CAPTURE_BYTES_MARGIN } from "../shared/constants";
import { logger } from "../core/utils/logger";

const BRIDGE_LOAD_TIMEOUT_MS = 10_000;
const EXPORT_TIMEOUT_MS = 30_000;
/** No ack / ready / result from the bridge for this long fails the transfer */
const BRIDGE_IDLE_TIMEOUT_MS = 30_000;
const MAX_IN_FLIGHT = 8;
const MAX_SESSIONS = 32;
const MAX_TRACKS = 8;
const MAX_EXPORT_CHUNKS = 100_000;

type Kind = "video" | "audio" | "unknown";
type TrackContainer = "mp4" | "webm" | "unknown";

interface ExportedTrack {
  kind: Kind;
  mime: string;
  container: TrackContainer;
  chunks: ArrayBuffer[];
}

interface PageStatus {
  armed: boolean;
  limitReached: boolean;
  totalBytes: number;
  sessions: CaptureSessionStatus[];
}

type StatusListener = (status: PageStatus) => void;
type ActionResult = { success: boolean; error?: string };

const EMPTY_STATUS: PageStatus = { armed: false, limitReached: false, totalBytes: 0, sessions: [] };

let lastStatus: PageStatus = EMPTY_STATUS;
let saving = false;
let started = false;
let maxBytes = 0;
const listeners = new Set<StatusListener>();
const pendingExports = new Map<
  string,
  { resolve: (tracks: ExportedTrack[]) => void; reject: (e: Error) => void }
>();

// ------------------------------------------------------------ validation

function finiteNumber(v: unknown, max = Number.MAX_SAFE_INTEGER): number | undefined {
  const n = typeof v === "number" ? v : NaN;
  return Number.isFinite(n) && n >= 0 && n <= max ? n : undefined;
}

function kindOf(v: unknown): Kind {
  return v === "video" || v === "audio" ? v : "unknown";
}

function containerOf(v: unknown): TrackContainer {
  return v === "mp4" || v === "webm" ? v : "unknown";
}

function shortString(v: unknown, max = 120): string {
  return typeof v === "string" ? v.slice(0, max) : "";
}

function sanitizeTrack(raw: unknown): CaptureTrackStatus {
  const t = (raw ?? {}) as Record<string, unknown>;
  return {
    kind: kindOf(t.kind),
    mime: shortString(t.mime),
    segments: Math.floor(finiteNumber(t.segments) ?? 0),
    bytes: Math.floor(finiteNumber(t.bytes) ?? 0),
  };
}

function sanitizeSession(raw: unknown): CaptureSessionStatus | null {
  if (!raw || typeof raw !== "object") return null;
  const s = raw as Record<string, unknown>;
  const id = Number(s.id);
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  const tracks = Array.isArray(s.tracks) ? s.tracks.slice(0, MAX_TRACKS).map(sanitizeTrack) : [];
  return {
    id,
    tracks,
    bytes: Math.floor(finiteNumber(s.bytes) ?? 0),
    duration: finiteNumber(s.duration, 1e7),
    capturedSeconds: finiteNumber(s.capturedSeconds, 1e7),
    drm: s.drm === true,
    width: finiteNumber(s.width, 1e5),
    height: finiteNumber(s.height, 1e5),
  };
}

function sanitizeStatus(raw: unknown): PageStatus | null {
  if (!raw || typeof raw !== "object") return null;
  const s = raw as Record<string, unknown>;
  const sessions = Array.isArray(s.sessions)
    ? s.sessions
        .slice(0, MAX_SESSIONS)
        .map(sanitizeSession)
        .filter((x): x is CaptureSessionStatus => x !== null)
    : [];
  return {
    armed: s.armed === true,
    limitReached: s.limitReached === true,
    totalBytes: Math.floor(finiteNumber(s.totalBytes) ?? 0),
    sessions,
  };
}

function sanitizeTracks(raw: unknown): ExportedTrack[] {
  if (!Array.isArray(raw)) throw new Error("Invalid capture data from page");
  let chunkCount = 0;
  return raw.slice(0, MAX_TRACKS).map((t) => {
    const chunks = (t as { chunks?: unknown })?.chunks;
    if (!Array.isArray(chunks) || !chunks.every((c) => c instanceof ArrayBuffer)) {
      throw new Error("Invalid capture data from page");
    }
    chunkCount += chunks.length;
    if (chunkCount > MAX_EXPORT_CHUNKS) throw new Error("Capture has too many segments");
    return {
      kind: kindOf((t as ExportedTrack).kind),
      mime: shortString((t as ExportedTrack).mime),
      container: containerOf((t as ExportedTrack).container),
      chunks: chunks as ArrayBuffer[],
    };
  });
}

// ------------------------------------------------------------- page bus

function postToPage(msg: Record<string, unknown>): void {
  window.postMessage({ channel: CAPTURE_CHANNEL, dir: "to-page", ...msg }, "*");
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

function onStatus(status: PageStatus): void {
  // Enforce the user's memory cap from the isolated world.
  if (status.armed && maxBytes > 0 && status.totalBytes >= maxBytes) {
    postToPage({ cmd: "limit" });
    status = { ...status, armed: false, limitReached: true };
  }
  lastStatus = status;
  notify();
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
    title: document.title.slice(0, 300),
    pageUrl: location.href,
  };
}

/** Find the capture session feeding a given media element (by size/duration heuristics). */
export function sessionForElement(el: HTMLMediaElement): CaptureSessionStatus | undefined {
  if (!el.currentSrc?.startsWith("blob:") && !el.src?.startsWith("blob:")) return undefined;
  const sessions = lastStatus.sessions;
  if (sessions.length <= 1) return sessions[0];
  const v = el as HTMLVideoElement;
  return (
    sessions.find((s) => s.width === v.videoWidth && s.height === v.videoHeight && s.duration === el.duration) ??
    sessions.reduce((a, b) => (b.bytes > a.bytes ? b : a))
  );
}

export function runCaptureAction(action: CaptureAction, sessionId?: number): Promise<ActionResult> {
  if (!started) return Promise.resolve({ success: false, error: "Stream capture is disabled" });
  const id = Number.isSafeInteger(sessionId) ? sessionId : undefined;
  switch (action) {
    case "start":
      postToPage({ cmd: "arm" });
      return Promise.resolve({ success: true });
    case "boost":
      postToPage({ cmd: "boost", sessionId: id });
      return Promise.resolve({ success: true });
    case "discard":
      postToPage({ cmd: "disarm" });
      postToPage({ cmd: "discard" });
      return Promise.resolve({ success: true });
    case "stop-save":
      return saveCapture(id);
    default:
      return Promise.resolve({ success: false, error: "Unknown capture action" });
  }
}

function requestExport(sessionId?: number): Promise<ExportedTrack[]> {
  const reqId = crypto.randomUUID();
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

// ----------------------------------------------------------------- save

/** Pick one video and one audio track; a single track may contain both (muxed). */
function selectTracks(tracks: ExportedTrack[]): { video?: ExportedTrack; audio?: ExportedTrack } {
  const usable = tracks.filter((t) => t.chunks.length > 0);
  const video = usable.find((t) => t.kind === "video") ?? usable.find((t) => t.kind === "unknown");
  const audio = usable.find((t) => t.kind === "audio");
  if (!video && audio) return { video: audio };
  return { video, audio };
}

function outputContainer(video?: ExportedTrack, audio?: ExportedTrack): "mp4" | "webm" | "mkv" {
  const containers = [video?.container, audio?.container].filter(Boolean);
  if (containers.every((c) => c === "mp4")) return "mp4";
  if (containers.every((c) => c === "webm")) return "webm";
  return "mkv";
}

function trackBytes(t?: ExportedTrack): number {
  return t ? t.chunks.reduce((n, c) => n + c.byteLength, 0) : 0;
}

async function saveCapture(sessionId?: number): Promise<ActionResult> {
  if (saving) return { success: false, error: "A capture is already being saved" };
  saving = true;
  notify();
  try {
    const tracks = sanitizeTracks(await requestExport(sessionId));
    const { video, audio } = selectTracks(tracks);
    if (!video) return { success: false, error: "No media was captured" };
    if (maxBytes > 0 && trackBytes(video) + trackBytes(audio) > maxBytes + CAPTURE_BYTES_MARGIN) {
      return { success: false, error: "Capture exceeds the memory limit set in Media Bridge settings" };
    }

    const container = outputContainer(video, audio);
    try {
      await transferViaBridge(video, audio, container);
      return { success: true };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      logger.warn("[Media Bridge] Capture bridge failed, saving raw tracks:", error);
      const saved = await saveRawTracks([video, audio].filter(Boolean) as ExportedTrack[]);
      if (saved === 0) return { success: false, error: `Saving the capture failed: ${reason}` };
      return {
        success: true,
        error:
          saved === 1
            ? `Merging failed (${reason}). Saved the unmerged stream instead.`
            : `Merging failed (${reason}). Saved video and audio as separate files instead. If the browser asks, allow this site to download multiple files.`,
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

/**
 * Copy every chunk to the bridge with at most MAX_IN_FLIGHT unacknowledged,
 * then wait for the final result. Rejects on bridge error or BRIDGE_IDLE_TIMEOUT_MS
 * without progress. On rejection the service worker has been told to abort.
 */
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
    },
  });
  if (!prep?.success || !prep.token || !prep.downloadId) {
    throw new Error(prep?.error || "Service worker refused capture");
  }
  const token = prep.token;

  const bridgeUrl = chrome.runtime.getURL("capture-bridge/bridge.html");
  const bridgeOrigin = new URL(bridgeUrl).origin;
  const iframe = document.createElement("iframe");
  iframe.src = bridgeUrl;
  iframe.setAttribute("aria-hidden", "true");
  iframe.style.cssText =
    "position:fixed!important;width:0!important;height:0!important;border:0!important;opacity:0!important;pointer-events:none!important;";
  const channel = new MessageChannel();
  let idleTimer: ReturnType<typeof setTimeout> | undefined;

  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Capture bridge did not load")), BRIDGE_LOAD_TIMEOUT_MS);
      iframe.addEventListener(
        "load",
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
      (document.body || document.documentElement).appendChild(iframe);
    });

    const queue: { slot: "video" | "audio"; index: number; data: ArrayBuffer }[] = [];
    video.chunks.forEach((data, index) => queue.push({ slot: "video", index, data }));
    audio?.chunks.forEach((data, index) => queue.push({ slot: "audio", index, data }));
    let next = 0;
    let inFlight = 0;
    let doneSent = false;

    await new Promise<void>((resolve, reject) => {
      const touch = () => {
        clearTimeout(idleTimer);
        idleTimer = setTimeout(() => reject(new Error("Capture bridge stopped responding")), BRIDGE_IDLE_TIMEOUT_MS);
      };
      const pump = () => {
        while (inFlight < MAX_IN_FLIGHT && next < queue.length) {
          const c = queue[next++];
          inFlight++;
          // No transfer list: the bridge gets a copy and these buffers stay ours.
          channel.port1.postMessage({ type: "chunk", slot: c.slot, index: c.index, data: c.data });
        }
        if (!doneSent && next >= queue.length && inFlight === 0) {
          doneSent = true;
          channel.port1.postMessage({ type: "done" });
        }
      };
      channel.port1.onmessage = (event) => {
        const m = event.data;
        touch();
        if (m?.type === "ready") {
          pump();
        } else if (m?.type === "ack") {
          inFlight = Math.max(0, inFlight - 1);
          pump();
        } else if (m?.type === "result") {
          if (m.success) resolve();
          else reject(new Error(typeof m.error === "string" ? m.error : "Capture bridge failed"));
        }
      };
      touch();
      iframe.contentWindow!.postMessage(
        { channel: CAPTURE_BRIDGE_CHANNEL, token, downloadId: prep.downloadId },
        bridgeOrigin,
        [channel.port2],
      );
    });
  } catch (error) {
    // Make sure the service worker cleans up now rather than at its timeout.
    // A no-op if the bridge already aborted or the capture was finalized.
    const reason = error instanceof Error ? error.message : String(error);
    sendRuntimeMessage({ type: MessageType.CAPTURE_ABORT, payload: { token, reason } }).catch(() => {});
    throw error;
  } finally {
    clearTimeout(idleTimer);
    channel.port1.close();
    iframe.remove();
  }
}

/** Gap between fallback downloads; back-to-back clicks are dropped by the browser. */
const RAW_SAVE_GAP_MS = 1000;

/**
 * Fallback save: each track as its own file via a page-origin blob URL.
 * Returns how many downloads were started. The browser may still ask the user
 * to allow a second download from the same page.
 */
async function saveRawTracks(tracks: ExportedTrack[]): Promise<number> {
  const base = (document.title || "capture").replace(/[\\/:*?"<>|]+/g, "_").slice(0, 120);
  let saved = 0;
  for (const t of tracks) {
    if (t.chunks.length === 0) continue;
    if (saved > 0) await new Promise((r) => setTimeout(r, RAW_SAVE_GAP_MS));
    try {
      const ext = t.container === "webm" ? "webm" : t.kind === "audio" ? "m4a" : "mp4";
      const blob = new Blob(t.chunks, { type: t.mime.split(";")[0] || "application/octet-stream" });
      if (blob.size === 0) continue;
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${base} (${t.kind}).${ext}`;
      a.style.display = "none";
      document.documentElement.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
      saved++;
    } catch (error) {
      logger.warn("[Media Bridge] Raw track save failed:", error);
    }
  }
  return saved;
}

// ----------------------------------------------------------------- init

/**
 * Wire up page <-> content messaging and popup handlers. Safe to call more
 * than once; only the first call installs listeners.
 */
export function initCaptureClient(options: { maxBytes: number }): void {
  maxBytes = options.maxBytes;
  if (started) return;
  started = true;

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const msg = event.data;
    if (!msg || msg.channel !== CAPTURE_CHANNEL || msg.dir !== "to-content") return;

    if (msg.evt === "status") {
      const status = sanitizeStatus(msg.status);
      if (status) onStatus(status);
    } else if (msg.evt === "export-result" && typeof msg.reqId === "string") {
      const pending = pendingExports.get(msg.reqId);
      if (!pending) return;
      pendingExports.delete(msg.reqId);
      if (msg.error) pending.reject(new Error(shortString(msg.error, 300) || "Export failed"));
      else pending.resolve(msg.tracks as ExportedTrack[]);
    }
  });

  postToPage({ cmd: "status" });

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (sender.id !== chrome.runtime.id) return false;
    if (message?.type === MessageType.CAPTURE_GET_STATUS) {
      sendResponse(getFrameStatus(Number(message.payload?.frameId) || 0));
      return false;
    }
    if (message?.type === MessageType.CAPTURE_COMMAND) {
      runCaptureAction(message.payload?.action as CaptureAction, message.payload?.sessionId).then(sendResponse);
      return true;
    }
    return false;
  });
}

export function updateCaptureLimit(bytes: number): void {
  maxBytes = bytes;
}
