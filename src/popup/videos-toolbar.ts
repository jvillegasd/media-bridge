/**
 * Videos tab toolbar: detected count + "Download all" (bulk, via the service
 * worker so it works the same as the context menu / keyboard shortcut).
 */

import { VideoMetadata } from "../core/types";
import { MessageType } from "../shared/messages";

function downloadableCount(videos: VideoMetadata[]): number {
  return videos.filter((v) => !v.hasDrm && !v.unsupported && !v.isLive).length;
}

export function updateVideosToolbar(videos: VideoMetadata[]): void {
  const bar = document.getElementById("videosToolbar");
  const count = document.getElementById("videosCount");
  const btn = document.getElementById("downloadAllBtn") as HTMLButtonElement | null;
  if (!bar || !count || !btn) return;

  const n = downloadableCount(videos);
  bar.style.display = videos.length > 0 ? "flex" : "none";
  count.textContent = `${videos.length} detected${n !== videos.length ? ` · ${n} downloadable` : ""}`;
  if (!btn.dataset.busy) btn.disabled = n < 2;
}

export function setupVideosToolbar(): void {
  const btn = document.getElementById("downloadAllBtn") as HTMLButtonElement | null;
  if (!btn) return;
  btn.addEventListener("click", async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return;
    btn.dataset.busy = "1";
    btn.disabled = true;
    const original = btn.textContent;
    btn.textContent = "Starting…";
    try {
      const res = await chrome.runtime.sendMessage({
        type: MessageType.DOWNLOAD_ALL_DETECTED,
        payload: { tabId: tab.id },
      });
      btn.textContent = res?.started ? `Started ${res.started}` : "Nothing new";
    } catch {
      btn.textContent = "Failed";
    }
    setTimeout(() => {
      delete btn.dataset.busy;
      btn.textContent = original;
      btn.disabled = false;
    }, 2000);
  });
}
