/**
 * Page-level actions that don't need the popup open:
 * - Context menu: download a <video>/<audio> element or a media link, or every
 *   detected video on the page
 * - Keyboard shortcut: download the best video detected in the active tab
 * - DOWNLOAD_ALL_DETECTED: bulk download from the popup
 */

import { VideoFormat, VideoMetadata } from "../core/types";
import { MessageType } from "../shared/messages";
import { detectFormatFromUrl, normalizeUrl } from "../core/utils/url-utils";
import { logger } from "../core/utils/logger";

type DownloadFn = (payload: {
  url: string;
  metadata: VideoMetadata;
  tabTitle?: string;
  website?: string;
}) => Promise<{ error?: string } | void>;

const MENU_DOWNLOAD_MEDIA = "mb-download-media";
const MENU_DOWNLOAD_LINK = "mb-download-link";
const MENU_DOWNLOAD_ALL = "mb-download-all";
const MENU_CAPTURE = "mb-capture";

const MEDIA_LINK_PATTERNS = [
  "mp4", "webm", "mov", "mkv", "m4v", "flv", "avi", "wmv", "ogv", "m3u8", "mpd",
].flatMap((ext) => [`*://*/*.${ext}`, `*://*/*.${ext}?*`]);

let download: DownloadFn | null = null;

function websiteOf(url?: string): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return undefined;
  }
}

function notify(title: string, message: string): void {
  chrome.notifications.create({
    type: "basic",
    iconUrl: "icons/icon-48.png",
    title,
    message,
  });
}

/** Ask every frame of a tab for its detected videos, deduplicated by URL. */
export async function collectTabVideos(tabId: number): Promise<VideoMetadata[]> {
  let frames: { frameId: number }[] = [{ frameId: 0 }];
  try {
    const all = await chrome.webNavigation.getAllFrames({ tabId });
    if (all?.length) frames = all;
  } catch {
    // fall back to top frame
  }
  const results = await Promise.allSettled(
    frames.map(
      (f) =>
        new Promise<VideoMetadata[]>((resolve) => {
          chrome.tabs.sendMessage(
            tabId,
            { type: MessageType.GET_DETECTED_VIDEOS },
            { frameId: f.frameId },
            (response) => {
              if (chrome.runtime.lastError) return resolve([]);
              resolve(Array.isArray(response?.videos) ? response.videos : []);
            },
          );
        }),
    ),
  );
  const byUrl = new Map<string, VideoMetadata>();
  for (const r of results) {
    if (r.status !== "fulfilled") continue;
    for (const v of r.value) {
      const key = normalizeUrl(v.url);
      if (!byUrl.has(key)) byUrl.set(key, v);
    }
  }
  return [...byUrl.values()];
}

function isDownloadable(v: VideoMetadata): boolean {
  return !v.hasDrm && !v.unsupported && !v.isLive && v.format !== VideoFormat.UNKNOWN;
}

/** Highest resolution first; adaptive manifests beat progressive files of equal height. */
export function pickBestVideo(videos: VideoMetadata[]): VideoMetadata | undefined {
  const score = (v: VideoMetadata) =>
    (v.height || parseInt(v.resolution || "", 10) || 0) * 10 +
    (v.format === VideoFormat.HLS || v.format === VideoFormat.DASH ? 5 : 0) +
    (v.size ? Math.min(4, v.size / 1e9) : 0);
  return videos.filter(isDownloadable).sort((a, b) => score(b) - score(a))[0];
}

async function startDownloads(videos: VideoMetadata[], tab?: chrome.tabs.Tab): Promise<number> {
  if (!download) return 0;
  let started = 0;
  for (const v of videos) {
    try {
      const res = await download({
        url: v.url,
        metadata: v,
        tabTitle: v.title || tab?.title,
        website: websiteOf(tab?.url ?? v.pageUrl),
      });
      if (!res || !res.error) started++;
    } catch (error) {
      logger.warn("Bulk download item failed:", error);
    }
  }
  return started;
}

export async function downloadAllDetected(tabId: number): Promise<{ success: boolean; started: number; skipped: number }> {
  const tab = await chrome.tabs.get(tabId).catch(() => undefined);
  const videos = await collectTabVideos(tabId);
  const eligible = videos.filter(isDownloadable);
  const started = await startDownloads(eligible, tab);
  return { success: true, started, skipped: videos.length - eligible.length };
}

/** Build metadata for a URL the user picked explicitly (link / element context menu). */
async function metadataForUrl(url: string, pageUrl: string, title?: string): Promise<VideoMetadata> {
  let format = detectFormatFromUrl(url);
  let isLive = false;
  if (format === VideoFormat.HLS) {
    try {
      const text = await (await fetch(url, { signal: AbortSignal.timeout(8000) })).text();
      if (!text.includes("#EXT-X-STREAM-INF")) {
        format = VideoFormat.M3U8;
        isLive = !text.includes("#EXT-X-ENDLIST");
      }
    } catch {
      // let the download handler surface the error
    }
  }
  if (format === VideoFormat.UNKNOWN) format = VideoFormat.DIRECT;
  return { url, format, pageUrl, title, isLive };
}

async function handleMediaUrl(url: string, tab: chrome.tabs.Tab | undefined): Promise<void> {
  if (!download) return;
  const metadata = await metadataForUrl(url, tab?.url ?? "", tab?.title);
  if (metadata.isLive) {
    notify("Live stream", "Open the Media Bridge popup to record this live stream.");
    return;
  }
  const res = await download({ url, metadata, tabTitle: tab?.title, website: websiteOf(tab?.url) });
  if (res && res.error) notify("Download not started", res.error);
}

async function downloadBestInTab(tab: chrome.tabs.Tab | undefined): Promise<void> {
  if (!tab?.id) return;
  const best = pickBestVideo(await collectTabVideos(tab.id));
  if (!best) {
    notify(
      "No downloadable video found",
      "Play the video first. For players without a detectable source, use Stream capture from the in-page button or popup.",
    );
    return;
  }
  const started = await startDownloads([best], tab);
  if (started) notify("Download started", best.title || tab.title || best.url);
}

function sendCaptureBoost(tabId: number, frameId: number): void {
  chrome.tabs.sendMessage(
    tabId,
    { type: MessageType.CAPTURE_COMMAND, payload: { action: "boost" } },
    { frameId },
    () => void chrome.runtime.lastError,
  );
}

function createMenus(): void {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: MENU_DOWNLOAD_MEDIA,
      title: "Download this video with Media Bridge",
      contexts: ["video", "audio"],
    });
    chrome.contextMenus.create({
      id: MENU_CAPTURE,
      title: "Capture this stream (fast, from start)",
      contexts: ["video"],
    });
    chrome.contextMenus.create({
      id: MENU_DOWNLOAD_LINK,
      title: "Download linked media with Media Bridge",
      contexts: ["link"],
      targetUrlPatterns: MEDIA_LINK_PATTERNS,
    });
    chrome.contextMenus.create({
      id: MENU_DOWNLOAD_ALL,
      title: "Download all detected videos on this page",
      contexts: ["page", "frame", "video"],
    });
  });
}

export function initPageActions(downloadFn: DownloadFn): void {
  download = downloadFn;

  chrome.runtime.onInstalled.addListener(createMenus);
  chrome.runtime.onStartup.addListener(createMenus);

  chrome.contextMenus.onClicked.addListener(async (info, tab) => {
    try {
      switch (info.menuItemId) {
        case MENU_DOWNLOAD_MEDIA: {
          const src = info.srcUrl || "";
          if (/^https?:/i.test(src)) {
            await handleMediaUrl(src, tab);
          } else {
            // blob:/MediaSource element — fall back to the best detected source
            await downloadBestInTab(tab);
          }
          break;
        }
        case MENU_CAPTURE:
          if (tab?.id !== undefined) sendCaptureBoost(tab.id, info.frameId ?? 0);
          break;
        case MENU_DOWNLOAD_LINK:
          if (info.linkUrl) await handleMediaUrl(info.linkUrl, tab);
          break;
        case MENU_DOWNLOAD_ALL:
          if (tab?.id !== undefined) {
            const { started } = await downloadAllDetected(tab.id);
            notify(
              started ? "Downloads started" : "Nothing to download",
              started ? `${started} video${started === 1 ? "" : "s"} queued` : "No downloadable videos detected on this page yet.",
            );
          }
          break;
      }
    } catch (error) {
      logger.error("Context menu action failed:", error);
    }
  });

  chrome.commands.onCommand.addListener(async (command, tab) => {
    const active = tab ?? (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
    if (command === "download-best-video") {
      await downloadBestInTab(active);
    } else if (command === "download-all-videos" && active?.id !== undefined) {
      const { started } = await downloadAllDetected(active.id);
      notify(started ? "Downloads started" : "Nothing to download", started ? `${started} queued` : "No downloadable videos detected.");
    }
  });
}
