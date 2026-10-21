/**
 * Network sniffer: classifies completed requests as HLS / DASH / direct media
 * using both the URL and the response headers, and forwards hits to the
 * content script of the frame that made the request.
 *
 * Compared to URL-extension matching alone this catches:
 * - manifests served from extension-less endpoints (`/playlist?id=…`) that are
 *   identified only by `Content-Type: application/vnd.apple.mpegurl` or
 *   `application/dash+xml`
 * - progressive MP4/WebM files fetched by <video> (request type `media`) from
 *   CDNs that strip extensions, sized from Content-Range/Content-Length
 *
 * Segment requests (TS/m4s chunks, byte-range slices) and small clips are
 * filtered out so the popup only lists whole, downloadable videos.
 *
 * Detections that arrive before the frame's content script is listening
 * (autoplay players often fetch their manifest before document_idle) are queued
 * and replayed when the content script reports CONTENT_READY.
 */

import { VideoFormat } from "../core/types";
import { MessageType } from "../shared/messages";
import { detectFormatFromUrl } from "../core/utils/url-utils";
import { loadSettings } from "../core/storage/settings";

const MAX_SEEN_PER_TAB = 2000;
const MAX_PENDING_PER_TAB = 100;
const PENDING_TTL_MS = 60_000;

const HLS_CONTENT_TYPE = /mpegurl/i;
const DASH_CONTENT_TYPE = /dash\+xml/i;
const SEGMENT_CONTENT_TYPE = /mp2t|iso\.segment|vnd\.yt-ump/i;
/** URL shapes that indicate a slice of a stream rather than a whole file */
const SEGMENT_URL =
  /\.(ts|m4s|m4f|m4a|aac|cmfv|cmfa|vtt|webvtt)(\?|$)|[?&](range|bytestart|byterange|start_byte)=|\/range\/\d+-\d+|\/seg(ment)?[-_]?\d+/i;

interface NetworkHit {
  url: string;
  format: VideoFormat;
  size?: number;
}

interface PendingHit {
  frameId: number;
  hit: NetworkHit;
  at: number;
}

const seenByTab = new Map<number, Set<string>>();
const pendingByTab = new Map<number, PendingHit[]>();
let minDirectBytes = 512 * 1024;

function header(
  headers: chrome.webRequest.HttpHeader[] | undefined,
  name: string,
): string {
  const h = headers?.find((x) => x.name.toLowerCase() === name);
  return h?.value ?? "";
}

/** Total resource size from Content-Range ("bytes 0-99/12345") or Content-Length. */
function totalSize(headers: chrome.webRequest.HttpHeader[] | undefined): number | undefined {
  const range = header(headers, "content-range");
  const m = range.match(/\/(\d+)\s*$/);
  if (m) return Number(m[1]);
  const len = Number(header(headers, "content-length"));
  return Number.isFinite(len) && len > 0 ? len : undefined;
}

export function classifyResponse(
  details: chrome.webRequest.WebResponseCacheDetails,
): NetworkHit | null {
  const { url } = details;
  if (!/^https?:/i.test(url)) return null;
  if (details.statusCode && details.statusCode >= 400) return null;

  const contentType = header(details.responseHeaders, "content-type").toLowerCase();
  const urlFormat = detectFormatFromUrl(url);

  if (urlFormat === VideoFormat.HLS || HLS_CONTENT_TYPE.test(contentType)) {
    return { url, format: VideoFormat.HLS };
  }
  if (urlFormat === VideoFormat.DASH || DASH_CONTENT_TYPE.test(contentType)) {
    return { url, format: VideoFormat.DASH };
  }

  // Direct media: require a video Content-Type, or an explicit video extension
  // on a media/octet-stream response. The "/video/ in path" URL heuristic alone
  // is far too noisy for network sniffing.
  const isVideoType = contentType.startsWith("video/") && !SEGMENT_CONTENT_TYPE.test(contentType);
  const hasVideoExtension = /\.(mp4|webm|mov|mkv|m4v|flv|avi|wmv|ogv)(\?|$)/i.test(new URL(url).pathname);
  const looseType = contentType === "" || contentType.includes("octet-stream") || contentType.startsWith("video/");
  if (!isVideoType && !(hasVideoExtension && looseType && details.type === "media")) {
    return null;
  }
  if (SEGMENT_URL.test(url)) return null;

  const size = totalSize(details.responseHeaders);
  if (size !== undefined && size < minDirectBytes) return null;

  return { url, format: VideoFormat.DIRECT, size };
}

function dedupeKey(hit: NetworkHit): string {
  try {
    const u = new URL(hit.url);
    // Direct files are often re-requested with rotating tokens; manifests too.
    return `${hit.format}:${u.origin}${u.pathname}`;
  } catch {
    return `${hit.format}:${hit.url}`;
  }
}

function markSeen(tabId: number, key: string): boolean {
  let seen = seenByTab.get(tabId);
  if (!seen) {
    seen = new Set();
    seenByTab.set(tabId, seen);
  }
  if (seen.has(key)) return false;
  if (seen.size >= MAX_SEEN_PER_TAB) {
    const first = seen.values().next().value;
    if (first) seen.delete(first);
  }
  seen.add(key);
  return true;
}

function queuePending(tabId: number, frameId: number, hit: NetworkHit): void {
  const list = pendingByTab.get(tabId) ?? [];
  list.push({ frameId, hit, at: Date.now() });
  if (list.length > MAX_PENDING_PER_TAB) list.shift();
  pendingByTab.set(tabId, list);
}

function deliver(tabId: number, frameId: number, hit: NetworkHit, queueOnFailure: boolean): void {
  chrome.tabs.sendMessage(
    tabId,
    { type: MessageType.NETWORK_URL_DETECTED, payload: hit },
    { frameId: frameId >= 0 ? frameId : 0 },
    () => {
      if (chrome.runtime.lastError && queueOnFailure) {
        // Content script not injected yet — replay on CONTENT_READY.
        queuePending(tabId, frameId, hit);
      }
    },
  );
}

/** Replay detections queued for a frame whose content script just became ready. */
export function replayPending(tabId: number, frameId: number): void {
  const list = pendingByTab.get(tabId);
  if (!list?.length) return;
  const now = Date.now();
  const remaining: PendingHit[] = [];
  for (const p of list) {
    if (now - p.at > PENDING_TTL_MS) continue;
    if (p.frameId === frameId || (p.frameId < 0 && frameId === 0)) {
      deliver(tabId, frameId, p.hit, false);
    } else {
      remaining.push(p);
    }
  }
  if (remaining.length) pendingByTab.set(tabId, remaining);
  else pendingByTab.delete(tabId);
}

/** Forget per-tab state (new top-level navigation or tab closed). */
export function resetTab(tabId: number): void {
  seenByTab.delete(tabId);
  pendingByTab.delete(tabId);
}

async function refreshSettings(): Promise<void> {
  try {
    const { ui } = await loadSettings();
    minDirectBytes = ui.minDirectSizeKb * 1024;
  } catch {
    // keep default
  }
}

export function initNetworkSniffer(): void {
  refreshSettings();
  chrome.storage.onChanged.addListener((_changes, area) => {
    if (area === "local") refreshSettings();
  });

  chrome.webRequest.onCompleted.addListener(
    (details) => {
      if (details.tabId < 0) return;
      const hit = classifyResponse(details);
      if (!hit) return;
      if (!markSeen(details.tabId, dedupeKey(hit))) return;
      deliver(details.tabId, details.frameId, hit, true);
    },
    { urls: ["http://*/*", "https://*/*"], types: ["xmlhttprequest", "media", "other"] },
    ["responseHeaders"],
  );

  chrome.webNavigation.onCommitted.addListener((details) => {
    if (details.frameId === 0) {
      // Keep queued hits from this navigation's own early requests; drop stale ones.
      seenByTab.delete(details.tabId);
      const list = pendingByTab.get(details.tabId);
      if (list) {
        const fresh = list.filter((p) => p.at >= details.timeStamp - 1000);
        if (fresh.length) pendingByTab.set(details.tabId, fresh);
        else pendingByTab.delete(details.tabId);
      }
    }
  });

  chrome.tabs.onRemoved.addListener((tabId) => resetTab(tabId));
}
