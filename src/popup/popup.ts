/**
 * Popup entry point: initialization, tab switching, theme, and message routing.
 */

import { VideoMetadata, DownloadStage, VideoFormat } from "../core/types";
import { getAllDownloads, deleteDownload } from "../core/database/downloads";
import { MessageType } from "../shared/messages";
import { normalizeUrl } from "../core/utils/url-utils";
import { ChromeStorage } from "../core/storage/chrome-storage";
import {
  dom,
  detectedVideos,
  setDetectedVideos,
  loadDownloadStates,
} from "./state";
import { renderDownloads } from "./render-downloads";
import { renderDetectedVideos, setupDetectedVideosEventDelegation } from "./render-videos";
import { handleOpenDownload, handleRemoveDownload, handleRetryDownload } from "./download-actions";
import {
  updateManualManifestFormState,
  updateDownloadButtonState,
  handleLoadManifestPlaylist,
  handleStartManifestDownload,
} from "./render-manifest";
import { switchTab } from "./tabs";

const RENDER_DEBOUNCE_MS = 200;

// ---- Debounce state ----
let renderDebounceTimer: ReturnType<typeof setTimeout> | null = null;
let fullRenderRequested = false;

function scheduleDebouncedRender(needsFullRender: boolean): void {
  if (needsFullRender) fullRenderRequested = true;

  if (renderDebounceTimer) return;

  renderDebounceTimer = setTimeout(async () => {
    renderDebounceTimer = null;
    const doFull = fullRenderRequested;
    fullRenderRequested = false;

    await loadDownloadStates();

    renderDetectedVideos(doFull);
    if (doFull) {
      renderDownloads(true);
      updateManualManifestFormState();
    } else {
      renderDownloads();
    }
  }, RENDER_DEBOUNCE_MS);
}

// ---- No-video notice ----

function showNoVideoNotice(): void {
  if (!dom.noVideoNotice) return;
  dom.noVideoNotice.classList.add("show");
  dom.noVideoNotice.style.display = "block";
}

function hideNoVideoNotice(): void {
  if (!dom.noVideoNotice) return;
  dom.noVideoNotice.classList.remove("show");
  dom.noVideoNotice.style.display = "none";
}

// ---- Force detection ----

async function handleForceDetection(): Promise<void> {
  const btn = (document.getElementById("forceDetectionBtn") ||
    document.querySelector(".empty-state-action")) as HTMLButtonElement | null;
  if (!btn) return;
  const originalText = btn.textContent;
  btn.disabled = true;
  btn.textContent = "Refreshing...";

  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const activeTab = tabs[0];

    if (!activeTab || activeTab.id === undefined) {
      throw new Error("Active tab not found");
    }

    await new Promise<void>((resolve, reject) => {
      chrome.tabs.reload(activeTab.id!, { bypassCache: true }, () => {
        const error = chrome.runtime.lastError;
        if (error) {
          reject(new Error(error.message));
        } else {
          resolve();
        }
      });
    });

    hideNoVideoNotice();
    window.close();
  } catch (error) {
    console.error("Failed to refresh tab for force detection:", error);
    alert("Failed to refresh the page. Please try again.");
  } finally {
    btn.disabled = false;
    btn.textContent = originalText || "Force detection";
  }
}

// ---- Clear completed ----

async function handleClearCompleted(): Promise<void> {
  try {
    const allDownloads = await getAllDownloads();

    const downloadsToClear = allDownloads.filter(
      (download) =>
        download.progress.stage === DownloadStage.COMPLETED ||
        download.progress.stage === DownloadStage.FAILED ||
        download.progress.stage === DownloadStage.CANCELLED,
    );

    if (downloadsToClear.length === 0) return;

    for (const download of downloadsToClear) {
      await deleteDownload(download.id);
    }

    await loadDownloadStates();
    renderDetectedVideos();
    renderDownloads(true);
  } catch (error) {
    console.error("Failed to clear completed downloads:", error);
  }
}

// ---- Request detected videos from content script ----

async function requestDetectedVideos(): Promise<void> {
  try {
    if (!chrome?.runtime || !chrome?.tabs) {
      console.debug("Chrome runtime or tabs API not available");
      return;
    }

    const [tab] = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });
    if (!tab?.id) return;

    const tabId = tab.id;

    // Get all frames in the tab (top frame + iframes)
    // chrome.webNavigation may not be available in all contexts, fall back to top frame only
    let frames: Array<{ frameId: number }>;
    if (chrome.webNavigation?.getAllFrames) {
      const allFrames = await chrome.webNavigation.getAllFrames({ tabId });
      frames = allFrames && allFrames.length > 0 ? allFrames : [{ frameId: 0 }];
    } else {
      frames = [{ frameId: 0 }];
    }

    // Query each frame for detected videos
    const frameResponses = await Promise.allSettled(
      frames.map(
        (frame) =>
          new Promise<any>((resolve, reject) => {
            chrome.tabs.sendMessage(
              tabId,
              { type: MessageType.GET_DETECTED_VIDEOS },
              { frameId: frame.frameId },
              (response) => {
                if (chrome.runtime.lastError) {
                  reject(new Error(chrome.runtime.lastError.message || "Unknown error"));
                  return;
                }
                resolve(response);
              },
            );
          }),
      ),
    );

    // Filter to keep only videos from the current page
    const currentUrl = tab.url || "";
    const filteredVideos: Record<string, VideoMetadata> = {};
    for (const [url, video] of Object.entries(detectedVideos)) {
      if (!(video as VideoMetadata).pageUrl.includes(currentUrl)) {
        filteredVideos[url] = video as VideoMetadata;
      }
    }
    setDetectedVideos(filteredVideos);

    // Merge videos from all frames, deduplicating by normalized URL
    for (const result of frameResponses) {
      if (result.status !== "fulfilled") continue;
      const response = result.value;
      if (!response?.videos || !Array.isArray(response.videos)) continue;

      for (const video of response.videos as VideoMetadata[]) {
        const normalizedVideoUrl = normalizeUrl(video.url);
        const existing = detectedVideos[normalizedVideoUrl];

        if (!existing) {
          detectedVideos[normalizedVideoUrl] = video;
        } else {
          if (video.title && !existing.title) existing.title = video.title;
          if (video.thumbnail && !existing.thumbnail) existing.thumbnail = video.thumbnail;
          if (video.resolution && !existing.resolution) existing.resolution = video.resolution;
          if (video.width && !existing.width) existing.width = video.width;
          if (video.height && !existing.height) existing.height = video.height;
          if (video.duration && !existing.duration) existing.duration = video.duration;
        }
      }
    }

    renderDetectedVideos();
  } catch (error) {
    console.debug("Could not get detected videos:", error);
  }
}

// ---- Video detection message handlers ----

function removeDetectedVideo(url: string | undefined): void {
  if (!url) return;
  const normalizedUrl = normalizeUrl(url);
  if (detectedVideos[normalizedUrl]) {
    delete detectedVideos[normalizedUrl];
    renderDetectedVideos();
  }
}

function addDetectedVideo(video: VideoMetadata): void {
  if (video.format === VideoFormat.UNKNOWN) {
    const normalizedUrl = normalizeUrl(video.url);
    if (detectedVideos[normalizedUrl]) {
      delete detectedVideos[normalizedUrl];
      renderDetectedVideos();
    }
    return;
  }

  const normalizedUrl = normalizeUrl(video.url);

  if (!detectedVideos[normalizedUrl]) {
    detectedVideos[normalizedUrl] = video;
    renderDetectedVideos();
  } else {
    const existing = detectedVideos[normalizedUrl];
    let updated = false;

    if (video.title && !existing.title) { existing.title = video.title; updated = true; }
    if (video.thumbnail && !existing.thumbnail) { existing.thumbnail = video.thumbnail; updated = true; }
    if (video.resolution && !existing.resolution) { existing.resolution = video.resolution; updated = true; }
    if (video.width && !existing.width) { existing.width = video.width; updated = true; }
    if (video.height && !existing.height) { existing.height = video.height; updated = true; }
    if (video.duration && !existing.duration) { existing.duration = video.duration; updated = true; }

    if (updated) {
      renderDetectedVideos();
    }
  }
}

// ---- Theme ----

async function loadTheme(): Promise<void> {
  const theme = await ChromeStorage.get<string>("theme");
  const isLightMode = theme === "light";
  applyTheme(isLightMode);
}

function applyTheme(isLightMode: boolean): void {
  const root = document.documentElement;
  if (isLightMode) {
    root.classList.add("light-mode");
  } else {
    root.classList.remove("light-mode");
  }
  updateThemeIcon(isLightMode);
}

function updateThemeIcon(isLightMode: boolean): void {
  const themeIcon = document.getElementById("themeIcon") as unknown as SVGElement | null;
  if (!themeIcon) return;

  if (isLightMode) {
    themeIcon.innerHTML = `<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"></path>`;
  } else {
    themeIcon.innerHTML = `
      <circle cx="12" cy="12" r="5"></circle>
      <line x1="12" y1="1" x2="12" y2="3"></line>
      <line x1="12" y1="21" x2="12" y2="23"></line>
      <line x1="4.22" y1="4.22" x2="5.64" y2="5.64"></line>
      <line x1="18.36" y1="18.36" x2="19.78" y2="19.78"></line>
      <line x1="1" y1="12" x2="3" y2="12"></line>
      <line x1="21" y1="12" x2="23" y2="12"></line>
      <line x1="4.22" y1="19.78" x2="5.64" y2="18.36"></line>
      <line x1="18.36" y1="5.64" x2="19.78" y2="4.22"></line>
    `;
  }
}

async function toggleTheme(): Promise<void> {
  const root = document.documentElement;
  const isLightMode = root.classList.contains("light-mode");
  const newTheme = isLightMode ? "dark" : "light";

  await ChromeStorage.set("theme", newTheme);
  applyTheme(!isLightMode);
}

// ---- Downloads event delegation ----

function setupDownloadsEventDelegation(): void {
  if (!dom.downloadsList) return;

  dom.downloadsList.addEventListener("click", async (e) => {
    const target = e.target as HTMLElement;

    // Clear all button in section headers
    const clearBtn = target.closest<HTMLElement>(".section-clear-btn");
    if (clearBtn) {
      e.stopPropagation();
      await handleClearCompleted();
      return;
    }

    const openBtn = target.closest<HTMLElement>(".download-open-btn");
    if (openBtn) {
      const downloadId = openBtn.dataset.downloadId;
      if (downloadId) await handleOpenDownload(downloadId);
      return;
    }

    const removeBtn = target.closest<HTMLElement>(".download-remove-btn");
    if (removeBtn) {
      e.stopPropagation();
      const downloadId = removeBtn.dataset.downloadId;
      if (downloadId) await handleRemoveDownload(downloadId);
      return;
    }

    const retryBtn = target.closest<HTMLElement>(".download-retry-btn");
    if (retryBtn) {
      const downloadId = retryBtn.dataset.downloadId;
      if (downloadId) await handleRetryDownload(downloadId);
      return;
    }

    const stopRecBtn = target.closest<HTMLElement>(".download-stop-rec-btn");
    if (stopRecBtn) {
      const url = stopRecBtn.dataset.url;
      if (url) {
        chrome.runtime.sendMessage({
          type: MessageType.STOP_RECORDING,
          payload: { url },
        });
      }
      return;
    }

    const stopSaveBtn = target.closest<HTMLElement>("[data-action='stop-save']");
    if (stopSaveBtn) {
      e.stopPropagation();
      const url = stopSaveBtn.dataset.url;
      if (url) {
        chrome.runtime.sendMessage({
          type: MessageType.STOP_AND_SAVE_DOWNLOAD,
          payload: { url },
        });
      }
      return;
    }
  });
}

// ---- Initialization ----

async function init(): Promise<void> {
  // Initialize DOM elements
  dom.forceDetectionBtn = document.getElementById("forceDetectionBtn") as HTMLButtonElement;
  dom.closeNoVideoNoticeBtn = document.getElementById("closeNoVideoNotice") as HTMLButtonElement;
  dom.noVideoNotice = document.getElementById("noVideoNotice") as HTMLDivElement;
  dom.settingsBtn = document.getElementById("settingsBtn") as HTMLButtonElement;
  dom.autoDetectTab = document.getElementById("autoDetectTab") as HTMLButtonElement;
  dom.manifestTab = document.getElementById("manifestTab") as HTMLButtonElement;
  dom.downloadsTab = document.getElementById("downloadsTab") as HTMLButtonElement;
  dom.autoDetectContent = document.getElementById("autoDetectContent") as HTMLDivElement;
  dom.manifestContent = document.getElementById("manifestContent") as HTMLDivElement;
  dom.downloadsContent = document.getElementById("downloadsContent") as HTMLDivElement;
  dom.downloadsList = document.getElementById("downloadsList") as HTMLDivElement;
  dom.startManifestDownloadBtn = document.getElementById("startHlsDownloadBtn") as HTMLButtonElement;
  dom.loadManifestPlaylistBtn = document.getElementById("loadHlsPlaylistBtn") as HTMLButtonElement;
  dom.videoQualitySelect = document.getElementById("videoQualitySelect") as HTMLSelectElement;
  dom.audioQualitySelect = document.getElementById("audioQualitySelect") as HTMLSelectElement;
  dom.manifestUrlInput = document.getElementById("manifestUrlInput") as HTMLInputElement;
  dom.manifestMediaPlaylistWarning = document.getElementById("hlsMediaPlaylistWarning") as HTMLDivElement;
  dom.manifestDrmWarning = document.getElementById("hlsDrmWarning") as HTMLDivElement;
  dom.manifestUnsupportedWarning = document.getElementById("hlsUnsupportedWarning") as HTMLDivElement;
  dom.manifestLiveStreamInfo = document.getElementById("hlsLiveStreamInfo") as HTMLDivElement;
  dom.manifestQualitySelection = document.getElementById("hlsQualitySelection") as HTMLDivElement;
  dom.manifestProgress = document.getElementById("manifestProgress") as HTMLDivElement;
  dom.detectedVideosList = document.getElementById("detectedVideosList") as HTMLDivElement;
  dom.themeToggle = document.getElementById("themeToggle") as HTMLButtonElement;
  dom.themeIcon = document.getElementById("themeIcon") as unknown as SVGElement;

  // Ensure notice is hidden initially
  if (dom.noVideoNotice) {
    dom.noVideoNotice.classList.remove("show");
  }

  await loadTheme();

  // Theme toggle
  if (dom.themeToggle) {
    dom.themeToggle.addEventListener("click", toggleTheme);
  }

  // Settings
  if (dom.settingsBtn) {
    dom.settingsBtn.addEventListener("click", () => {
      chrome.runtime.openOptionsPage();
    });
  }

  // No-video notice
  if (dom.closeNoVideoNoticeBtn) dom.closeNoVideoNoticeBtn.addEventListener("click", hideNoVideoNotice);
  if (dom.forceDetectionBtn) dom.forceDetectionBtn.addEventListener("click", handleForceDetection);

  // Tab switching
  if (dom.autoDetectTab) dom.autoDetectTab.addEventListener("click", async () => await switchTab("auto"));
  if (dom.manifestTab) dom.manifestTab.addEventListener("click", async () => await switchTab("manual"));
  if (dom.downloadsTab) dom.downloadsTab.addEventListener("click", async () => await switchTab("downloads"));

  // Manifest tab
  if (dom.startManifestDownloadBtn) dom.startManifestDownloadBtn.addEventListener("click", handleStartManifestDownload);
  if (dom.loadManifestPlaylistBtn) dom.loadManifestPlaylistBtn.addEventListener("click", handleLoadManifestPlaylist);
  if (dom.manifestUrlInput) {
    dom.manifestUrlInput.addEventListener("keypress", (e) => {
      if (e.key === "Enter") handleLoadManifestPlaylist();
    });
  }
  if (dom.videoQualitySelect) dom.videoQualitySelect.addEventListener("change", updateDownloadButtonState);
  if (dom.audioQualitySelect) dom.audioQualitySelect.addEventListener("change", updateDownloadButtonState);

  // Event delegation (once, not per render)
  setupDownloadsEventDelegation();
  setupDetectedVideosEventDelegation();

  // Event delegation for force-detect in empty state
  if (dom.detectedVideosList) {
    dom.detectedVideosList.addEventListener("click", (e) => {
      const target = e.target as HTMLElement;
      const forceBtn = target.closest<HTMLElement>(".empty-state-action");
      if (forceBtn) {
        handleForceDetection();
      }
    });
  }

  // Message listener
  chrome.runtime.onMessage.addListener(async (message) => {
    if (chrome.runtime.lastError && chrome.runtime.lastError.message) {
      if (chrome.runtime.lastError.message.includes("Extension context invalidated")) {
        console.debug("Extension context invalidated, reloading popup may be needed");
        return;
      }
    }

    try {
      if (message.type === MessageType.DOWNLOAD_PROGRESS) {
        scheduleDebouncedRender(false);
      } else if (
        message.type === MessageType.DOWNLOAD_COMPLETE ||
        message.type === MessageType.DOWNLOAD_FAILED
      ) {
        if (message.type === MessageType.DOWNLOAD_FAILED && message.payload?.error) {
          console.warn("Download failed:", message.payload.error);
        }
        scheduleDebouncedRender(true);
      } else if (message.type === MessageType.VIDEO_DETECTED) {
        addDetectedVideo(message.payload);
      } else if (message.type === MessageType.VIDEO_REMOVED) {
        removeDetectedVideo(message.payload?.url);
      }
    } catch (error) {
      console.debug("Error handling message:", error);
    }
  });

  // Initial data load
  await loadDownloadStates();
  renderDownloads();
  await requestDetectedVideos();
  renderDetectedVideos();
}

// Initialize when DOM is ready
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
