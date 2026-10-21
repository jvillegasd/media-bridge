/**
 * Stream capture panel (Videos tab).
 *
 * Lists frames of the active tab whose players use MediaSource and lets the
 * user start / fast-start / save / discard a capture. Status is polled from
 * each frame's content script while the popup is open — there is no SW cache,
 * so it is always accurate even after a service worker restart.
 */

import {
  MessageType,
  CaptureAction,
  CaptureFrameStatus,
  CaptureSessionStatus,
} from "../shared/messages";
import { escapeHtml, formatFileSize } from "./utils";

const POLL_MS = 1000;

let tabId: number | undefined;
let timer: ReturnType<typeof setInterval> | null = null;
let lastRender = "";
let busy = false;

async function queryFrames(): Promise<CaptureFrameStatus[]> {
  if (tabId === undefined) return [];
  let frames: { frameId: number }[] = [{ frameId: 0 }];
  try {
    const all = await chrome.webNavigation.getAllFrames({ tabId });
    if (all?.length) frames = all;
  } catch {
    // top frame only
  }
  const results = await Promise.all(
    frames.map(
      (f) =>
        new Promise<CaptureFrameStatus | null>((resolve) => {
          chrome.tabs.sendMessage(
            tabId!,
            { type: MessageType.CAPTURE_GET_STATUS, payload: { frameId: f.frameId } },
            { frameId: f.frameId },
            (res) => {
              if (chrome.runtime.lastError || !res) return resolve(null);
              resolve(res as CaptureFrameStatus);
            },
          );
        }),
    ),
  );
  return results.filter((r): r is CaptureFrameStatus => !!r && (r.sessions.length > 0 || r.armed || r.saving));
}

function formatSeconds(s?: number): string {
  if (!s) return "";
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, "0")}`;
}

function sessionLine(s: CaptureSessionStatus): string {
  const parts: string[] = [];
  if (s.width && s.height) parts.push(`${s.height}p`);
  const kinds = s.tracks.map((t) => t.kind).filter((k) => k !== "unknown");
  if (kinds.length) parts.push(kinds.join(" + "));
  parts.push(formatFileSize(s.bytes));
  if (s.capturedSeconds) {
    parts.push(`${formatSeconds(s.capturedSeconds)}${s.duration ? ` / ${formatSeconds(s.duration)}` : ""}`);
  }
  return parts.join(" · ");
}

function render(frames: CaptureFrameStatus[]): void {
  const panel = document.getElementById("capturePanel");
  if (!panel) return;
  const html = frames
    .map((f) => {
      const session = f.sessions.reduce<CaptureSessionStatus | undefined>(
        (a, b) => (!a || b.bytes > a.bytes ? b : a),
        undefined,
      );
      const drm = !!session?.drm;
      const hasData = (session?.bytes ?? 0) > 0;
      let actions = "";
      let hint = "";
      if (drm) {
        hint = "DRM-protected stream — capture is disabled.";
      } else if (f.saving) {
        actions = `<button class="secondary-btn small-btn" disabled>Saving…</button>`;
      } else if (f.armed || hasData) {
        actions = `
          <button class="primary-btn small-btn" data-action="stop-save" data-frame="${f.frameId}" data-session="${session?.id ?? ""}" ${hasData ? "" : "disabled"}>Stop &amp; save</button>
          <button class="secondary-btn small-btn" data-action="discard" data-frame="${f.frameId}" data-session="${session?.id ?? ""}">Discard</button>`;
        hint = f.armed
          ? "Recording what the player loads. Let it play to the end, then save."
          : "Capture paused.";
      } else {
        actions = `
          <button class="primary-btn small-btn" data-action="boost" data-frame="${f.frameId}" data-session="${session?.id ?? ""}" title="Restart muted at up to 16× speed and capture everything">⚡ Fast capture</button>
          <button class="secondary-btn small-btn" data-action="start" data-frame="${f.frameId}" data-session="${session?.id ?? ""}">Capture from here</button>`;
        hint = "For players with no detectable source. Lock quality in the player for best results.";
      }
      if (f.limitReached) hint = "Memory limit reached — capture paused. Save now.";
      const where = (() => {
        try {
          return new URL(f.pageUrl).hostname;
        } catch {
          return "";
        }
      })();
      return `
        <div class="capture-card">
          <div class="capture-head">
            <span class="capture-badge ${f.armed ? "rec" : ""}">${f.armed ? "● REC" : "STREAM"}</span>
            <span class="capture-title" title="${escapeHtml(f.title)}">${escapeHtml(f.title || where || "Media stream")}</span>
          </div>
          ${session ? `<div class="capture-meta">${escapeHtml(sessionLine(session))}${f.frameId !== 0 && where ? ` · ${escapeHtml(where)}` : ""}</div>` : ""}
          ${actions ? `<div class="capture-actions">${actions}</div>` : ""}
          ${hint ? `<div class="capture-hint">${escapeHtml(hint)}</div>` : ""}
        </div>`;
    })
    .join("");
  if (html === lastRender) return;
  lastRender = html;
  panel.innerHTML = html;
  panel.style.display = frames.length ? "block" : "none";
}

async function poll(): Promise<void> {
  if (busy) return;
  busy = true;
  try {
    render(await queryFrames());
  } finally {
    busy = false;
  }
}

function sendCommand(frameId: number, action: CaptureAction, sessionId?: number): Promise<{ success: boolean; error?: string }> {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(
      tabId!,
      { type: MessageType.CAPTURE_COMMAND, payload: { action, sessionId } },
      { frameId },
      (res) => {
        if (chrome.runtime.lastError) return resolve({ success: false, error: chrome.runtime.lastError.message });
        resolve(res ?? { success: true });
      },
    );
  });
}

export async function setupCapturePanel(): Promise<void> {
  const panel = document.getElementById("capturePanel");
  if (!panel) return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  tabId = tab?.id;
  if (tabId === undefined) return;

  panel.addEventListener("click", async (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>("button[data-action]");
    if (!btn || btn.disabled) return;
    const action = btn.dataset.action as CaptureAction;
    const frameId = Number(btn.dataset.frame);
    const sessionId = btn.dataset.session ? Number(btn.dataset.session) : undefined;
    btn.disabled = true;
    const res = await sendCommand(frameId, action, sessionId);
    if (!res.success && res.error) alert(res.error);
    else if (res.error) alert(res.error); // saved with a caveat (e.g. unmuxed fallback)
    lastRender = "";
    poll();
  });

  poll();
  timer = setInterval(poll, POLL_MS);
  window.addEventListener("unload", () => {
    if (timer) clearInterval(timer);
  });
}
