/**
 * Toolbar badge showing how many downloadable videos were detected in a tab.
 * Fed by the VIDEO_DETECTED / VIDEO_REMOVED messages content scripts already
 * broadcast; reset when the top frame (re)initializes.
 */

import { VideoFormat, VideoMetadata } from "../core/types";
import { normalizeUrl } from "../core/utils/url-utils";

const BADGE_COLOR = "#2563eb";
const videosByTab = new Map<number, Set<string>>();

function render(tabId: number): void {
  const count = videosByTab.get(tabId)?.size ?? 0;
  const text = count === 0 ? "" : count > 99 ? "99+" : String(count);
  chrome.action.setBadgeText({ tabId, text }).catch(() => {});
  if (count > 0) chrome.action.setBadgeBackgroundColor({ tabId, color: BADGE_COLOR }).catch(() => {});
}

export function badgeVideoDetected(tabId: number | undefined, video: VideoMetadata | undefined): void {
  if (tabId === undefined || !video?.url || video.format === VideoFormat.UNKNOWN) return;
  let set = videosByTab.get(tabId);
  if (!set) {
    set = new Set();
    videosByTab.set(tabId, set);
  }
  const key = normalizeUrl(video.url);
  if (set.has(key)) return;
  set.add(key);
  render(tabId);
}

export function badgeVideoRemoved(tabId: number | undefined, url: string | undefined): void {
  if (tabId === undefined || !url) return;
  if (videosByTab.get(tabId)?.delete(normalizeUrl(url))) render(tabId);
}

export function badgeReset(tabId: number | undefined): void {
  if (tabId === undefined) return;
  videosByTab.delete(tabId);
  render(tabId);
}

export function initBadge(): void {
  chrome.tabs.onRemoved.addListener((tabId) => videosByTab.delete(tabId));
}
