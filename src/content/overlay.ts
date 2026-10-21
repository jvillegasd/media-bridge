/**
 * In-page download button.
 *
 * Shows a small floating button in the corner of the video under the pointer.
 * Clicking it opens a menu with every downloadable source detected in this
 * frame, plus stream-capture controls when the video is fed by MediaSource.
 *
 * Rendered in a closed shadow root attached to <html> so page CSS cannot
 * restyle it and it cannot leak styles into the page. Pointer tracking is done
 * at the document level because most players cover the <video> with control
 * layers, so `mouseenter` on the element itself rarely fires.
 */

import { VideoMetadata, VideoFormat } from "../core/types";
import { MessageType, CaptureSessionStatus } from "../shared/messages";
import {
  getCaptureStatus,
  isCaptureSaving,
  onCaptureStatus,
  runCaptureAction,
  sessionForElement,
} from "./capture-client";

const MIN_VIDEO_WIDTH = 200;
const MIN_VIDEO_HEIGHT = 112;
const HIDE_DELAY_MS = 1500;

export interface OverlayOptions {
  getVideos: () => VideoMetadata[];
}

let host: HTMLElement | null = null;
let root: ShadowRoot | null = null;
let button: HTMLButtonElement | null = null;
let menu: HTMLDivElement | null = null;
let toastEl: HTMLDivElement | null = null;
let currentVideo: HTMLVideoElement | null = null;
let hideTimer: ReturnType<typeof setTimeout> | null = null;
let rafPending = false;
let lastPointer = { x: -1, y: -1 };
let enabled = false;
let opts: OverlayOptions | null = null;
let unsubscribeStatus: (() => void) | null = null;

const STYLES = `
  :host { all: initial; }
  * { box-sizing: border-box; font-family: Inter, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
  .btn {
    position: fixed; z-index: 2147483647; display: none; align-items: center; gap: 6px;
    height: 32px; padding: 0 12px 0 10px; border: 1px solid rgba(255,255,255,.18); border-radius: 16px;
    background: rgba(17, 24, 39, .86); color: #fff; font-size: 12px; font-weight: 600; cursor: pointer;
    backdrop-filter: blur(6px); box-shadow: 0 4px 16px rgba(0,0,0,.35); transition: background .15s, transform .15s;
  }
  .btn:hover { background: rgba(37, 99, 235, .95); transform: translateY(-1px); }
  .btn svg { width: 16px; height: 16px; }
  .btn.show { display: inline-flex; }
  .menu {
    position: fixed; z-index: 2147483647; display: none; min-width: 260px; max-width: 360px; max-height: 60vh; overflow-y: auto;
    background: #111827; color: #f9fafb; border: 1px solid #374151; border-radius: 10px; padding: 6px;
    box-shadow: 0 12px 32px rgba(0,0,0,.45); font-size: 12px;
  }
  .menu.show { display: block; }
  .hdr { padding: 6px 8px 8px; font-weight: 700; font-size: 12px; color: #93c5fd; letter-spacing: .02em; }
  .sec { padding: 8px 8px 4px; font-size: 10px; text-transform: uppercase; letter-spacing: .08em; color: #9ca3af; }
  .item {
    display: flex; align-items: center; gap: 8px; width: 100%; padding: 8px; border: 0; border-radius: 6px;
    background: transparent; color: inherit; text-align: left; font-size: 12px; cursor: pointer;
  }
  .item:hover:not(:disabled) { background: #1f2937; }
  .item:disabled { opacity: .5; cursor: not-allowed; }
  .tag { flex-shrink: 0; padding: 2px 6px; border-radius: 4px; background: #1e3a8a; color: #bfdbfe; font-size: 10px; font-weight: 700; }
  .tag.live { background: #7f1d1d; color: #fecaca; }
  .tag.cap { background: #14532d; color: #bbf7d0; }
  .label { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .meta { flex-shrink: 0; color: #9ca3af; font-size: 11px; }
  .note { padding: 6px 8px; color: #9ca3af; font-size: 11px; line-height: 1.4; }
  .toast {
    position: fixed; z-index: 2147483647; left: 50%; bottom: 24px; transform: translateX(-50%);
    display: none; padding: 10px 16px; border-radius: 8px; background: #111827; color: #f9fafb;
    border: 1px solid #374151; font-size: 13px; box-shadow: 0 8px 24px rgba(0,0,0,.4);
  }
  .toast.show { display: block; }
`;

const DOWNLOAD_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>`;

function ensureDom(): void {
  if (host) return;
  host = document.createElement("media-bridge-overlay");
  root = host.attachShadow({ mode: "closed" });
  const style = document.createElement("style");
  style.textContent = STYLES;
  button = document.createElement("button");
  button.className = "btn";
  button.innerHTML = `${DOWNLOAD_ICON}<span>Download</span>`;
  button.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    toggleMenu();
  });
  menu = document.createElement("div");
  menu.className = "menu";
  toastEl = document.createElement("div");
  toastEl.className = "toast";
  root.append(style, button, menu, toastEl);
  document.documentElement.appendChild(host);
}

function isEligible(v: HTMLVideoElement): DOMRect | null {
  const r = v.getBoundingClientRect();
  if (r.width < MIN_VIDEO_WIDTH || r.height < MIN_VIDEO_HEIGHT) return null;
  if (r.bottom < 0 || r.right < 0 || r.top > innerHeight || r.left > innerWidth) return null;
  const style = getComputedStyle(v);
  if (style.visibility === "hidden" || style.display === "none" || Number(style.opacity) === 0) return null;
  return r;
}

function videoAtPointer(x: number, y: number): HTMLVideoElement | null {
  let best: HTMLVideoElement | null = null;
  let bestArea = 0;
  for (const el of Array.from(document.querySelectorAll("video"))) {
    const r = isEligible(el);
    if (!r) continue;
    if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) {
      const area = r.width * r.height;
      if (area > bestArea) {
        best = el;
        bestArea = area;
      }
    }
  }
  return best;
}

function positionButton(): void {
  if (!button || !currentVideo) return;
  const r = currentVideo.getBoundingClientRect();
  const top = Math.max(8, r.top + 12);
  const left = Math.min(innerWidth - 130, r.right - 120);
  button.style.top = `${top}px`;
  button.style.left = `${Math.max(8, left)}px`;
}

function showButton(video: HTMLVideoElement): void {
  ensureDom();
  if (hideTimer) {
    clearTimeout(hideTimer);
    hideTimer = null;
  }
  if (currentVideo !== video) {
    currentVideo = video;
    closeMenu();
  }
  positionButton();
  button!.classList.add("show");
}

function scheduleHide(): void {
  if (hideTimer || menu?.classList.contains("show")) return;
  hideTimer = setTimeout(() => {
    hideTimer = null;
    if (menu?.classList.contains("show")) return;
    button?.classList.remove("show");
    currentVideo = null;
  }, HIDE_DELAY_MS);
}

function onPointerMove(e: PointerEvent): void {
  lastPointer = { x: e.clientX, y: e.clientY };
  if (rafPending) return;
  rafPending = true;
  requestAnimationFrame(() => {
    rafPending = false;
    if (!enabled) return;
    const v = videoAtPointer(lastPointer.x, lastPointer.y);
    if (v) showButton(v);
    else scheduleHide();
  });
}

function onScrollOrResize(): void {
  if (!currentVideo) return;
  positionButton();
  if (menu?.classList.contains("show")) positionMenu();
}

function onDocumentClick(e: MouseEvent): void {
  // Clicks inside our own shadow tree are handled by the button/menu themselves.
  if (host && e.composedPath().includes(host)) return;
  closeMenu();
}

function closeMenu(): void {
  menu?.classList.remove("show");
}

function positionMenu(): void {
  if (!menu || !button) return;
  const b = button.getBoundingClientRect();
  menu.style.top = `${Math.min(b.bottom + 6, innerHeight - 80)}px`;
  menu.style.left = `${Math.max(8, Math.min(b.right - 300, innerWidth - 368))}px`;
}

function toggleMenu(): void {
  if (!menu) return;
  if (menu.classList.contains("show")) {
    closeMenu();
    return;
  }
  renderMenu();
  positionMenu();
  menu.classList.add("show");
}

function formatTag(v: VideoMetadata): string {
  if (v.format === VideoFormat.DIRECT) return (v.fileExtension || "MP4").toUpperCase();
  return v.format.toUpperCase();
}

function formatBytes(n: number): string {
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function rankVideos(videos: VideoMetadata[], el: HTMLVideoElement | null): VideoMetadata[] {
  const src = el?.currentSrc || el?.src || "";
  const score = (v: VideoMetadata) =>
    (v.url === src ? 1e7 : 0) +
    (v.hasDrm || v.unsupported ? -1e8 : 0) +
    (v.height || 0) * 10 +
    (v.format === VideoFormat.HLS || v.format === VideoFormat.DASH ? 5 : 0);
  return [...videos].sort((a, b) => score(b) - score(a));
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function menuItem(tag: string, tagCls: string, label: string, meta: string, onClick: (() => void) | null): HTMLButtonElement {
  const item = el("button", "item");
  item.append(el("span", `tag ${tagCls}`, tag), el("span", "label", label));
  if (meta) item.append(el("span", "meta", meta));
  if (onClick) item.addEventListener("click", onClick);
  else item.disabled = true;
  return item;
}

function renderMenu(): void {
  if (!menu || !opts) return;
  menu.replaceChildren();
  menu.append(el("div", "hdr", "Media Bridge"));

  const videos = rankVideos(opts.getVideos(), currentVideo);
  const elementSrc = currentVideo?.currentSrc || currentVideo?.src || "";
  const hasElementDirect =
    /^https?:/i.test(elementSrc) && !videos.some((v) => v.url === elementSrc);

  if (videos.length > 0 || hasElementDirect) {
    menu.append(el("div", "sec", "Download"));
  }
  for (const v of videos) {
    const label = v.title || document.title || v.url;
    const meta = [v.resolution, v.size ? formatBytes(v.size) : ""].filter(Boolean).join(" · ");
    if (v.hasDrm || v.unsupported) {
      menu.append(menuItem(formatTag(v), "", label, "DRM — not downloadable", null));
    } else if (v.isLive) {
      menu.append(menuItem("LIVE", "live", `Record: ${label}`, meta, () => record(v)));
    } else {
      menu.append(menuItem(formatTag(v), "", label, meta, () => download(v)));
    }
  }
  if (hasElementDirect) {
    const v: VideoMetadata = {
      url: elementSrc,
      format: VideoFormat.DIRECT,
      pageUrl: location.href,
      title: document.title,
    };
    menu.append(menuItem("FILE", "", "This video's source file", "", () => download(v)));
  }

  renderCaptureSection(menu, videos.length > 0 || hasElementDirect);
}

function renderCaptureSection(container: HTMLDivElement, hasDownloads: boolean): void {
  const status = getCaptureStatus();
  const session: CaptureSessionStatus | undefined = currentVideo ? sessionForElement(currentVideo) : undefined;
  const isMse = !!currentVideo && (currentVideo.currentSrc || currentVideo.src || "").startsWith("blob:");

  if (!session && !isMse) {
    if (!hasDownloads) {
      container.append(el("div", "note", "No downloadable source found yet. Start playback (and skip any ads) so the stream can be detected."));
    }
    return;
  }

  container.append(el("div", "sec", "Stream capture"));
  if (session?.drm) {
    container.append(el("div", "note", "This stream is DRM-protected. Capture is disabled."));
    return;
  }
  if (isCaptureSaving()) {
    container.append(menuItem("CAP", "cap", "Saving capture…", "", null));
    return;
  }

  const bytes = session?.bytes ?? 0;
  if (status.armed || bytes > 0) {
    const secs = session?.capturedSeconds ? ` · ${formatSeconds(session.capturedSeconds)}` : "";
    container.append(
      menuItem("CAP", "cap", "Stop & save capture", `${formatBytes(bytes)}${secs}`, bytes > 0 ? () => capture("stop-save", session?.id) : null),
      menuItem("CAP", "cap", "Discard capture", "", () => capture("discard", session?.id)),
    );
    if (status.armed) {
      container.append(el("div", "note", "Recording what the player loads. Let the video play to the end (or seek through it), then Stop & save."));
    }
  } else {
    container.append(
      menuItem("CAP", "cap", "Fast capture from start", "up to 16×", () => capture("boost", session?.id)),
      menuItem("CAP", "cap", "Capture from here", "", () => capture("start", session?.id)),
    );
    container.append(el("div", "note", "Use this when no source is listed above. Lock the player to one quality for best results."));
  }
  if (status.limitReached) {
    container.append(el("div", "note", "Memory limit reached — capture paused. Save now or raise the limit in Settings."));
  }
}

function formatSeconds(s: number): string {
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, "0")}`;
}

function toast(message: string): void {
  ensureDom();
  if (!toastEl) return;
  toastEl.textContent = message;
  toastEl.classList.add("show");
  setTimeout(() => toastEl?.classList.remove("show"), 3000);
}

function download(v: VideoMetadata): void {
  closeMenu();
  chrome.runtime.sendMessage(
    {
      type: MessageType.DOWNLOAD_REQUEST,
      payload: {
        url: v.url,
        metadata: v,
        tabTitle: v.title || document.title,
        website: location.hostname.replace(/^www\./, ""),
      },
    },
    (response) => {
      if (chrome.runtime.lastError) {
        toast("Media Bridge was updated — reload this page to continue");
        return;
      }
      toast(response?.success ? "Download started" : response?.error || "Download failed to start");
    },
  );
}

function record(v: VideoMetadata): void {
  closeMenu();
  chrome.runtime.sendMessage(
    {
      type: MessageType.START_RECORDING,
      payload: {
        url: v.url,
        metadata: v,
        tabTitle: v.title || document.title,
        website: location.hostname.replace(/^www\./, ""),
      },
    },
    () => {
      if (chrome.runtime.lastError) return;
      toast("Live recording started — stop it from the Media Bridge popup");
    },
  );
}

function capture(action: "start" | "boost" | "stop-save" | "discard", sessionId?: number): void {
  closeMenu();
  if (action === "stop-save") toast("Saving capture…");
  runCaptureAction(action, sessionId).then((res) => {
    if (action === "start") toast("Capture started — play the video");
    else if (action === "boost") toast("Fast capture started — let the video run to the end");
    else if (action === "discard") toast("Capture discarded");
    else toast(res.success ? res.error || "Capture saved — merging in the background" : res.error || "Capture failed");
  });
}

export function setOverlayEnabled(value: boolean, options?: OverlayOptions): void {
  if (options) opts = options;
  if (value === enabled) return;
  enabled = value;
  if (enabled) {
    document.addEventListener("pointermove", onPointerMove, { passive: true, capture: true });
    document.addEventListener("click", onDocumentClick, true);
    window.addEventListener("scroll", onScrollOrResize, { passive: true, capture: true });
    window.addEventListener("resize", onScrollOrResize, { passive: true });
    unsubscribeStatus = onCaptureStatus(() => {
      if (menu?.classList.contains("show")) renderMenu();
    });
  } else {
    document.removeEventListener("pointermove", onPointerMove, true);
    document.removeEventListener("click", onDocumentClick, true);
    window.removeEventListener("scroll", onScrollOrResize, true);
    window.removeEventListener("resize", onScrollOrResize);
    unsubscribeStatus?.();
    unsubscribeStatus = null;
    host?.remove();
    host = root = button = menu = toastEl = null;
    currentVideo = null;
  }
}
