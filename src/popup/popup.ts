/**
 * Popup entry point: initialization, tab switching, theme, and message routing.
 */

import { VideoMetadata, DownloadStage } from "../core/types";
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
const CLEAR_FEEDBACK_RESET_MS = 1000;

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

    if (doFull) {
      renderDetectedVideos();
      renderDownloads(true);
      updateManualManifestFormState();
    } else {
      renderDownloads();
    }
  }, RENDER_DEBOUNCE_MS);
}

// ---- Menu dropdowns ----

function closeAllMenuDropdowns(): void {
  document.querySelectorAll(".menu-dropdown-content").forEach((dropdown) => {
    dropdown.classList.remove("show");
  });
}

// ---- No-video notice ----

function showNoVideoNotice(): void {
  if (!dom.noVideoNotice) return;
  dom.noVideoNotice.classList.add("show");
  dom.noVideoNotice.classList.remove("visible");
  dom.noVideoNotice.style.display = "block";
}

function hideNoVideoNotice(): void {
  if (!dom.noVideoNotice) return;
  dom.noVideoNotice.classList.remove("show");
  dom.noVideoNotice.classList.remove("visible");
  dom.noVideoNotice.style.display = "none";
}

function toggleNoVideoNotice(): void {
  showNoVideoNotice();
}

// ---- Force detection ----

async function handleForceDetection(): Promise<void> {
  if (!dom.forceDetectionBtn) return;
  const originalText = dom.forceDetectionBtn.textContent;
  dom.forceDetectionBtn.disabled = true;
  dom.forceDetectionBtn.textContent = "Refreshing...";

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
    dom.forceDetectionBtn.disabled = false;
    dom.forceDetectionBtn.textContent = originalText || "Force detection";
  }
}

// ---- Downloads folder ----

async function handleOpenDownloads(): Promise<void> {
  try {
    await chrome.downloads.showDefaultFolder();
  } catch (error) {
    console.error("Failed to open downloads folder:", error);
    alert("Failed to open downloads folder. Please check your browser settings.");
  }
}

// ---- Clear completed ----

async function handleClearCompleted(): Promise<void> {
  const clearCompletedButtons = document.querySelectorAll("#clearCompletedBtn") as NodeListOf<HTMLButtonElement>;
  if (clearCompletedButtons.length === 0) return;

  const firstButton = clearCompletedButtons[0];
  const originalText = firstButton.querySelector("span")?.textContent;

  const updateAllButtons = (disabled: boolean, text?: string) => {
    clearCompletedButtons.forEach((btn) => {
      btn.disabled = disabled;
      if (text !== undefined && btn.querySelector("span")) {
        btn.querySelector("span")!.textContent = text;
      }
    });
  };

  try {
    updateAllButtons(true, "Clearing...");

    const allDownloads = await getAllDownloads();

    const downloadsToClear = allDownloads.filter(
      (download) =>
        download.progress.stage === DownloadStage.COMPLETED ||
        download.progress.stage === DownloadStage.FAILED ||
        download.progress.stage === DownloadStage.CANCELLED,
    );

    if (downloadsToClear.length === 0) {
      updateAllButtons(false, "Nothing to clear");
      setTimeout(() => {
        updateAllButtons(false, originalText || "Clear");
      }, CLEAR_FEEDBACK_RESET_MS);
      return;
    }

    for (const download of downloadsToClear) {
      await deleteDownload(download.id);
    }

    await loadDownloadStates();
    renderDetectedVideos();

    updateAllButtons(false, "Cleared!");
    setTimeout(() => {
      updateAllButtons(false, originalText || "Clear");
    }, CLEAR_FEEDBACK_RESET_MS);
  } catch (error) {
    console.error("Failed to clear completed downloads:", error);
    alert("Failed to clear completed downloads. Please try again.");
    updateAllButtons(false, originalText || "Clear");
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
    if (tab.id) {
      let response;
      try {
        response = await new Promise<any>((resolve, reject) => {
          chrome.tabs.sendMessage(
            tab.id!,
            { type: MessageType.GET_DETECTED_VIDEOS },
            (response) => {
              if (chrome.runtime.lastError) {
                const errorMessage = chrome.runtime.lastError.message || "";
                if (errorMessage.includes("Extension context invalidated")) {
                  console.debug(
                    "Extension context invalidated, cannot communicate with content script",
                  );
                  reject(new Error("Extension context invalidated"));
                  return;
                }
                reject(
                  new Error(chrome.runtime.lastError.message || "Unknown error"),
                );
                return;
              }
              resolve(response);
            },
          );
        });
      } catch (error: any) {
        if (error?.message?.includes("Extension context invalidated")) {
          console.debug(
            "Extension context invalidated, cannot communicate with content script",
          );
          return;
        }
        console.debug("Could not send message to content script:", error);
        return;
      }

      if (response && response.videos && Array.isArray(response.videos)) {
        const currentUrl = tab.url || "";
        const filteredVideos: Record<string, VideoMetadata> = {};
        for (const [url, video] of Object.entries(detectedVideos)) {
          if (!(video as VideoMetadata).pageUrl.includes(currentUrl)) {
            filteredVideos[url] = video as VideoMetadata;
          }
        }
        setDetectedVideos(filteredVideos);

        response.videos.forEach((video: VideoMetadata) => {
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
        });

        renderDetectedVideos();
      }
    }
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
  if (video.format === "unknown") {
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
  const themeIcons = document.querySelectorAll("#themeIcon") as NodeListOf<SVGElement>;

  const moonIcon = `
    <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"></path>
  `;
  const sunIcon = `
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

  themeIcons.forEach((icon) => {
    if (isLightMode) {
      icon.innerHTML = moonIcon;
    } else {
      icon.innerHTML = sunIcon;
    }
  });
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
  dom.noVideoBtn = document.getElementById("noVideoBtn") as HTMLButtonElement;
  dom.forceDetectionBtn = document.getElementById("forceDetectionBtn") as HTMLButtonElement;
  dom.closeNoVideoNoticeBtn = document.getElementById("closeNoVideoNotice") as HTMLButtonElement;
  dom.noVideoNotice = document.getElementById("noVideoNotice") as HTMLDivElement;
  dom.settingsBtn = document.getElementById("settingsBtn") as HTMLButtonElement;
  dom.downloadsBtn = document.getElementById("downloadsBtn") as HTMLButtonElement;
  dom.clearCompletedBtn = document.getElementById("clearCompletedBtn") as HTMLButtonElement;
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
  dom.themeToggle = document.querySelector("#themeToggle") as HTMLButtonElement;
  dom.themeIcon = document.querySelector("#themeIcon") as unknown as SVGElement;

  // Ensure notice is hidden initially
  if (dom.noVideoNotice) {
    dom.noVideoNotice.classList.remove("show");
    dom.noVideoNotice.classList.remove("visible");
  }

  await loadTheme();

  // Theme toggle
  if (dom.themeToggle) {
    dom.themeToggle.addEventListener("click", (e) => {
      e.stopPropagation();
      toggleTheme();
      closeAllMenuDropdowns();
    });
  }

  // Menu dropdowns
  document.querySelectorAll(".menu-dropdown").forEach((dropdown) => {
    const menuBtn = dropdown.querySelector(".bottom-bar-btn") as HTMLButtonElement;
    const menuContent = dropdown.querySelector(".menu-dropdown-content") as HTMLDivElement;

    if (menuBtn && menuContent) {
      menuBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        const isOpen = menuContent.classList.contains("show");
        closeAllMenuDropdowns();
        if (!isOpen) {
          menuContent.classList.add("show");
        }
      });
    }
  });

  document.addEventListener("click", (e) => {
    if (!(e.target as HTMLElement).closest(".menu-dropdown")) {
      closeAllMenuDropdowns();
    }
  });

  // Event listeners
  if (dom.noVideoBtn) dom.noVideoBtn.addEventListener("click", toggleNoVideoNotice);
  if (dom.closeNoVideoNoticeBtn) dom.closeNoVideoNoticeBtn.addEventListener("click", hideNoVideoNotice);
  if (dom.forceDetectionBtn) dom.forceDetectionBtn.addEventListener("click", handleForceDetection);
  document.querySelectorAll("#settingsBtn").forEach((btn) => {
    btn.addEventListener("click", () => { chrome.runtime.openOptionsPage(); });
  });
  document.querySelectorAll("#downloadsBtn").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      handleOpenDownloads();
      closeAllMenuDropdowns();
    });
  });
  document.querySelectorAll("#clearCompletedBtn").forEach((btn) => {
    btn.addEventListener("click", handleClearCompleted);
  });
  if (dom.autoDetectTab) dom.autoDetectTab.addEventListener("click", async () => await switchTab("auto"));
  if (dom.manifestTab) dom.manifestTab.addEventListener("click", async () => await switchTab("manual"));
  if (dom.downloadsTab) dom.downloadsTab.addEventListener("click", async () => await switchTab("downloads"));
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
