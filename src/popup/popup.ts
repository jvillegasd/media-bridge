/**
 * Popup UI for displaying detected videos and managing downloads
 */

import {
  DownloadState,
  VideoMetadata,
  VideoFormat,
  Level,
  DownloadStage,
} from "../core/types";
import {
  getAllDownloads,
  getDownload,
  deleteDownload,
  clearAllDownloads,
} from "../core/database/downloads";
import { MessageType } from "../shared/messages";
import { normalizeUrl, detectFormatFromUrl } from "../core/utils/url-utils";
import {
  parseMasterPlaylist,
  isMasterPlaylist,
  isMediaPlaylist,
} from "../core/utils/m3u8-parser";
import { ChromeStorage } from "../core/storage/chrome-storage";
import { canCancelDownload, CANNOT_CANCEL_MESSAGE } from "../core/utils/download-utils";

// DOM elements
let noVideoBtn: HTMLButtonElement | null = null;
let forceDetectionBtn: HTMLButtonElement | null = null;
let closeNoVideoNoticeBtn: HTMLButtonElement | null = null;
let noVideoNotice: HTMLDivElement | null = null;
let settingsBtn: HTMLButtonElement | null = null;
let downloadsBtn: HTMLButtonElement | null = null;
let clearCompletedBtn: HTMLButtonElement | null = null;
let autoDetectTab: HTMLButtonElement | null = null;
let manifestTab: HTMLButtonElement | null = null;
let downloadsTab: HTMLButtonElement | null = null;
let autoDetectContent: HTMLDivElement | null = null;
let manifestContent: HTMLDivElement | null = null;
let downloadsContent: HTMLDivElement | null = null;
let downloadsList: HTMLDivElement | null = null;
let startManifestDownloadBtn: HTMLButtonElement | null = null;
let loadManifestPlaylistBtn: HTMLButtonElement | null = null;
let videoQualitySelect: HTMLSelectElement | null = null;
let audioQualitySelect: HTMLSelectElement | null = null;
let manifestUrlInput: HTMLInputElement | null = null;
let manifestMediaPlaylistWarning: HTMLDivElement | null = null;
let manifestQualitySelection: HTMLDivElement | null = null;
let manifestProgress: HTMLDivElement | null = null;
let isMediaPlaylistMode: boolean = false;
let currentManualManifestUrl: string | null = null;
let themeToggle: HTMLButtonElement | null = null;
let themeIcon: SVGElement | null = null;

// List containers
const detectedVideosList = document.getElementById(
  "detectedVideosList",
) as HTMLDivElement;

let detectedVideos: Record<string, VideoMetadata> = {};
let downloadStates: DownloadState[] = [];

/**
 * Initialize popup
 */
async function init() {
  // Initialize DOM elements
  noVideoBtn = document.getElementById("noVideoBtn") as HTMLButtonElement;
  forceDetectionBtn = document.getElementById(
    "forceDetectionBtn",
  ) as HTMLButtonElement;
  closeNoVideoNoticeBtn = document.getElementById(
    "closeNoVideoNotice",
  ) as HTMLButtonElement;
  noVideoNotice = document.getElementById("noVideoNotice") as HTMLDivElement;
  settingsBtn = document.getElementById("settingsBtn") as HTMLButtonElement;
  downloadsBtn = document.getElementById("downloadsBtn") as HTMLButtonElement;
  clearCompletedBtn = document.getElementById(
    "clearCompletedBtn",
  ) as HTMLButtonElement;
  autoDetectTab = document.getElementById("autoDetectTab") as HTMLButtonElement;
  manifestTab = document.getElementById("manifestTab") as HTMLButtonElement;
  downloadsTab = document.getElementById("downloadsTab") as HTMLButtonElement;
  autoDetectContent = document.getElementById(
    "autoDetectContent",
  ) as HTMLDivElement;
  manifestContent = document.getElementById(
    "manifestContent",
  ) as HTMLDivElement;
  downloadsContent = document.getElementById(
    "downloadsContent",
  ) as HTMLDivElement;
  downloadsList = document.getElementById("downloadsList") as HTMLDivElement;
  startManifestDownloadBtn = document.getElementById(
    "startHlsDownloadBtn",
  ) as HTMLButtonElement;
  loadManifestPlaylistBtn = document.getElementById(
    "loadHlsPlaylistBtn",
  ) as HTMLButtonElement;
  videoQualitySelect = document.getElementById(
    "videoQualitySelect",
  ) as HTMLSelectElement;
  audioQualitySelect = document.getElementById(
    "audioQualitySelect",
  ) as HTMLSelectElement;
  manifestUrlInput = document.getElementById("manifestUrlInput") as HTMLInputElement;
  manifestMediaPlaylistWarning = document.getElementById(
    "hlsMediaPlaylistWarning",
  ) as HTMLDivElement;
  manifestQualitySelection = document.getElementById(
    "hlsQualitySelection",
  ) as HTMLDivElement;
  manifestProgress = document.getElementById(
    "manifestProgress",
  ) as HTMLDivElement;
  themeToggle = document.getElementById("themeToggle") as HTMLButtonElement;
  themeIcon = document.getElementById("themeIcon") as unknown as SVGElement;

  // Ensure notice is hidden initially
  if (noVideoNotice) {
    noVideoNotice.classList.remove("show");
    noVideoNotice.classList.remove("visible");
  }

  // Load and apply theme
  await loadTheme();

  // Setup theme toggle
  if (themeToggle) {
    themeToggle.addEventListener("click", toggleTheme);
  }

  // Setup event listeners
  // Use querySelectorAll to handle buttons that may appear in multiple tabs
  document.querySelectorAll("#noVideoBtn").forEach((btn) => {
    btn.addEventListener("click", toggleNoVideoNotice);
  });
  if (closeNoVideoNoticeBtn) {
    closeNoVideoNoticeBtn.addEventListener("click", hideNoVideoNotice);
  }
  if (forceDetectionBtn) {
    forceDetectionBtn.addEventListener("click", handleForceDetection);
  }
  document.querySelectorAll("#settingsBtn").forEach((btn) => {
    btn.addEventListener("click", () => {
      chrome.runtime.openOptionsPage();
    });
  });
  document.querySelectorAll("#downloadsBtn").forEach((btn) => {
    btn.addEventListener("click", handleOpenDownloads);
  });
  document.querySelectorAll("#clearCompletedBtn").forEach((btn) => {
    btn.addEventListener("click", handleClearCompleted);
  });
  if (autoDetectTab) {
    autoDetectTab.addEventListener("click", async () => await switchTab("auto"));
  }
  if (manifestTab) {
    manifestTab.addEventListener("click", async () => await switchTab("manual"));
  }
  if (downloadsTab) {
    downloadsTab.addEventListener("click", async () => await switchTab("downloads"));
  }
  if (startManifestDownloadBtn) {
    startManifestDownloadBtn.addEventListener("click", handleStartManifestDownload);
  }
  if (loadManifestPlaylistBtn) {
    loadManifestPlaylistBtn.addEventListener("click", handleLoadManifestPlaylist);
  }
  if (manifestUrlInput) {
    manifestUrlInput.addEventListener("keypress", (e) => {
      if (e.key === "Enter") {
        handleLoadManifestPlaylist();
      }
    });
  }
  if (videoQualitySelect) {
    videoQualitySelect.addEventListener("change", updateDownloadButtonState);
  }
  if (audioQualitySelect) {
    audioQualitySelect.addEventListener("change", updateDownloadButtonState);
  }

  // Listen for messages
  chrome.runtime.onMessage.addListener(async (message) => {
    // Check if extension context is still valid
    if (chrome.runtime.lastError && chrome.runtime.lastError.message) {
      if (
        chrome.runtime.lastError.message.includes(
          "Extension context invalidated",
        )
      ) {
        console.debug(
          "Extension context invalidated, reloading popup may be needed",
        );
        return;
      }
    }

    try {
      if (message.type === MessageType.DOWNLOAD_PROGRESS) {
        await loadDownloadStates();
        renderDetectedVideos();
        renderDownloads();
        updateManualManifestFormState();
      }
      if (message.type === MessageType.DOWNLOAD_COMPLETE) {
        await loadDownloadStates();
        renderDetectedVideos();
        renderDownloads();
        updateManualManifestFormState();
      }
      if (message.type === MessageType.VIDEO_DETECTED) {
        addDetectedVideo(message.payload);
      }
      if (message.type === MessageType.VIDEO_REMOVED) {
        removeDetectedVideo(message.payload?.url);
      }
      if (message.type === MessageType.SET_ICON_GRAY) {
        // Icon reset - just refresh the display (keep videos until page refresh)
        renderDetectedVideos();
      }
      if (message.type === MessageType.DOWNLOAD_FAILED) {
        await loadDownloadStates();
        renderDetectedVideos();
        renderDownloads();
        updateManualManifestFormState();
        // Log error for debugging
        if (message.payload && message.payload.error) {
          console.warn("Download failed:", message.payload.error);
        }
      }
    } catch (error) {
      console.debug("Error handling message:", error);
    }
  });

  // Load data
  await loadDownloadStates();
  renderDetectedVideos();
  renderDownloads();

  // Get detected videos from current tab
  await requestDetectedVideos();

  // Refresh state when popup regains focus (e.g., after being closed by download)
  // This ensures the UI shows current download progress when reopened
  document.addEventListener("visibilitychange", async () => {
    if (!document.hidden) {
      // Popup became visible - refresh download states
      await loadDownloadStates();
      renderDetectedVideos();
      renderDownloads();
    }
  });

  // Also refresh on window focus (for better compatibility)
  window.addEventListener("focus", async () => {
    await loadDownloadStates();
    renderDetectedVideos();
    renderDownloads();
  });

  // Periodic refresh while popup is open (every 2 seconds)
  // This ensures progress updates even if messages are missed
  setInterval(async () => {
    if (!document.hidden) {
      await loadDownloadStates();
      renderDetectedVideos();
      renderDownloads();
      updateManualManifestFormState();
    }
  }, 2000);
}

function showNoVideoNotice() {
  if (!noVideoNotice) return;
  noVideoNotice.classList.add("show");
  noVideoNotice.classList.remove("visible"); // Remove old class if exists
  // Force inline style as backup
  noVideoNotice.style.display = "block";
}

function hideNoVideoNotice() {
  if (!noVideoNotice) return;
  noVideoNotice.classList.remove("show");
  noVideoNotice.classList.remove("visible"); // Remove old class if exists
  // Force inline style as backup
  noVideoNotice.style.display = "none";
}

function toggleNoVideoNotice() {
  // Only show the notice, don't toggle - X button is used to close
  showNoVideoNotice();
}

async function handleForceDetection() {
  if (!forceDetectionBtn) return;
  const originalText = forceDetectionBtn.textContent;
  forceDetectionBtn.disabled = true;
  forceDetectionBtn.textContent = "Refreshing...";

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
    forceDetectionBtn.disabled = false;
    forceDetectionBtn.textContent = originalText || "Force detection";
  }
}

async function handleOpenDownloads() {
  if (!downloadsBtn) return;

  try {
    // Open the default downloads folder
    await chrome.downloads.showDefaultFolder();
  } catch (error) {
    console.error("Failed to open downloads folder:", error);
    alert(
      "Failed to open downloads folder. Please check your browser settings.",
    );
  }
}

async function handleClearCompleted() {
  const clearCompletedButtons = document.querySelectorAll("#clearCompletedBtn") as NodeListOf<HTMLButtonElement>;
  if (clearCompletedButtons.length === 0) return;

  const firstButton = clearCompletedButtons[0];
  const originalText = firstButton.querySelector("span")?.textContent;

  // Helper function to update all buttons
  const updateAllButtons = (disabled: boolean, text?: string) => {
    clearCompletedButtons.forEach((btn) => {
      btn.disabled = disabled;
      if (text !== undefined && btn.querySelector("span")) {
        btn.querySelector("span")!.textContent = text;
      }
    });
  };

  try {
    // Disable buttons and show loading state
    updateAllButtons(true, "Clearing...");

    // Get all downloads
    const allDownloads = await getAllDownloads();

    // Filter completed, failed, and cancelled downloads
    const downloadsToClear = allDownloads.filter(
      (download) =>
        download.progress.stage === DownloadStage.COMPLETED ||
        download.progress.stage === DownloadStage.FAILED ||
        download.progress.stage === DownloadStage.CANCELLED,
    );

    if (downloadsToClear.length === 0) {
      // No downloads to clear
      updateAllButtons(false, "Nothing to clear");
      setTimeout(() => {
        updateAllButtons(false, originalText || "Clear");
      }, 1000);
      return;
    }

    // Remove all completed, failed, and cancelled downloads
    for (const download of downloadsToClear) {
      await deleteDownload(download.id);
    }

    // Reload states and refresh UI
    await loadDownloadStates();
    renderDetectedVideos();

    // Show success feedback
    updateAllButtons(false, "Cleared!");
    setTimeout(() => {
      updateAllButtons(false, originalText || "Clear");
    }, 1000);
  } catch (error) {
    console.error("Failed to clear completed downloads:", error);
    alert("Failed to clear completed downloads. Please try again.");
    updateAllButtons(false, originalText || "Clear");
  }
}

/**
 * Request detected videos from current tab
 */
async function requestDetectedVideos() {
  try {
    // Check if runtime is available
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
            {
              type: MessageType.GET_DETECTED_VIDEOS,
            },
            (response) => {
              // Check for extension context invalidation after API call
              if (chrome.runtime.lastError) {
                const errorMessage = chrome.runtime.lastError.message || "";
                if (errorMessage.includes("Extension context invalidated")) {
                  console.debug(
                    "Extension context invalidated, cannot communicate with content script",
                  );
                  reject(new Error("Extension context invalidated"));
                  return;
                }
                // Other errors (content script not available, etc.) - ignore silently
                reject(
                  new Error(
                    chrome.runtime.lastError.message || "Unknown error",
                  ),
                );
                return;
              }
              resolve(response);
            },
          );
        });
      } catch (error: any) {
        // Handle extension context invalidated or content script not available
        if (error?.message?.includes("Extension context invalidated")) {
          console.debug(
            "Extension context invalidated, cannot communicate with content script",
          );
          return;
        }
        // Content script might not be available, ignore
        console.debug("Could not send message to content script:", error);
        return;
      }

      // Merge received videos with existing ones
      if (response && response.videos && Array.isArray(response.videos)) {
        const currentUrl = tab.url || "";
        const filteredVideos: Record<string, VideoMetadata> = {};
        for (const [url, video] of Object.entries(detectedVideos)) {
          if (!video.pageUrl.includes(currentUrl)) {
            filteredVideos[url] = video;
          }
        }
        detectedVideos = filteredVideos;

        response.videos.forEach((video: VideoMetadata) => {
          const normalizedVideoUrl = normalizeUrl(video.url);
          const existing = detectedVideos[normalizedVideoUrl];

          if (!existing) {
            detectedVideos[normalizedVideoUrl] = video;
          } else {
            if (video.title && !existing.title) {
              existing.title = video.title;
            }
            if (video.thumbnail && !existing.thumbnail) {
              existing.thumbnail = video.thumbnail;
            }
            if (video.resolution && !existing.resolution) {
              existing.resolution = video.resolution;
            }
            if (video.width && !existing.width) {
              existing.width = video.width;
            }
            if (video.height && !existing.height) {
              existing.height = video.height;
            }
            if (video.duration && !existing.duration) {
              existing.duration = video.duration;
            }
          }
        });

        renderDetectedVideos();
      }
    }
  } catch (error) {
    // Tab might not have content script, ignore
    console.debug("Could not get detected videos:", error);
  }
}

/**
 * Remove detected video from store and refresh UI
 */
function removeDetectedVideo(url: string | undefined) {
  if (!url) return;

  const normalizedUrl = normalizeUrl(url);

  if (detectedVideos[normalizedUrl]) {
    delete detectedVideos[normalizedUrl];
    renderDetectedVideos();
  }
}

/**
 * Add or update detected video in store and refresh UI
 */
function addDetectedVideo(video: VideoMetadata) {
  // Reject unknown formats - don't show them in UI
  if (video.format === "unknown") {
    // If it already exists, remove it
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

    if (video.title && !existing.title) {
      existing.title = video.title;
      updated = true;
    }
    if (video.thumbnail && !existing.thumbnail) {
      existing.thumbnail = video.thumbnail;
      updated = true;
    }
    if (video.resolution && !existing.resolution) {
      existing.resolution = video.resolution;
      updated = true;
    }
    if (video.width && !existing.width) {
      existing.width = video.width;
      updated = true;
    }
    if (video.height && !existing.height) {
      existing.height = video.height;
      updated = true;
    }
    if (video.duration && !existing.duration) {
      existing.duration = video.duration;
      updated = true;
    }

    if (updated) {
      renderDetectedVideos();
    }
  }
}

/**
 * Load download states
 */
async function loadDownloadStates() {
  downloadStates = await getAllDownloads();
}

/**
 * Find download state for a video by matching normalized URLs
 */
function getDownloadStateForVideo(
  video: VideoMetadata,
): DownloadState | undefined {
  const normalizedUrl = normalizeUrl(video.url);
  return downloadStates.find((d) => {
    if (!d.metadata) return false;
    return normalizeUrl(d.metadata.url) === normalizedUrl;
  });
}

/**
 * Render detected videos with download status and progress
 */
function renderDetectedVideos() {
  const uniqueVideos = Object.values(detectedVideos);

  if (uniqueVideos.length === 0) {
    detectedVideosList.innerHTML = `
      <div class="empty-state">
        No videos detected on this page.<br>
        Try turning off autoplay, restart the page and starting the video manually.
      </div>
    `;
    return;
  }

  detectedVideosList.innerHTML = uniqueVideos
    .map((video) => {
      const normalizedUrl = normalizeUrl(video.url);
      const downloadState = getDownloadStateForVideo(video);
      const isDownloading =
        downloadState &&
        downloadState.progress.stage !== DownloadStage.COMPLETED &&
        downloadState.progress.stage !== DownloadStage.FAILED &&
        downloadState.progress.stage !== DownloadStage.CANCELLED;
      const isCompleted =
        downloadState && downloadState.progress.stage === DownloadStage.COMPLETED;
      const isFailed =
        downloadState &&
        (downloadState.progress.stage === DownloadStage.FAILED ||
          downloadState.progress.stage === DownloadStage.CANCELLED);
      const isCancelled =
        downloadState && downloadState.progress.stage === DownloadStage.CANCELLED;
      const actualFormat = getActualFileFormat(video, downloadState);

      const displayResolution = (video.resolution || "").trim();
      const displayWidth = video.width;
      const displayHeight = video.height;
      const displayDimensions =
        !displayResolution && displayWidth && displayHeight
          ? `${displayWidth}x${displayHeight}`
          : "";

      let statusBadge = "";
      let progressBar = "";
      let buttonText = "Download";
      let buttonDisabled = false;

      if (isDownloading) {
        const stage = downloadState.progress.stage;
        statusBadge = `<span class="video-status status-${stage}">${getStatusText(
          stage,
        )}</span>`;

        // Check if this is a manifest or M3U8 download (format is 'hls' or 'm3u8')
        // Manifest/M3U8 downloads have speed tracking and show progress bar with real file size
        // Show detailed progress during downloading and merging stages
        const isManifestDownload =
          (video.format === "hls" || video.format === "m3u8") &&
          (stage === DownloadStage.DOWNLOADING || stage === DownloadStage.MERGING);

        if (isManifestDownload) {
          const percentage = downloadState.progress.percentage || 0;

          if (stage === DownloadStage.DOWNLOADING) {
            // Manifest downloading progress: progress bar, real file size, and speed
            const downloaded = downloadState.progress.downloaded || 0;
            const total = downloadState.progress.total || 0;
            const speed = downloadState.progress.speed || 0;

            const downloadedText = formatFileSize(downloaded);
            const totalText = total > 0 ? formatFileSize(total) : "?";
            const speedText = formatSpeed(speed);

            progressBar = `
            <div class="manifest-progress-container">
              <div class="manifest-progress-bar-wrapper">
                <div class="manifest-progress-bar" style="width: ${Math.min(
                  percentage,
                  100,
                )}%"></div>
              </div>
              <div class="manifest-progress-info">
                <span class="manifest-progress-size">${downloadedText} / ${totalText}</span>
                ${
                  speed > 0
                    ? `<span class="manifest-progress-speed">${speedText}</span>`
                    : ""
                }
              </div>
            </div>
          `;
          } else if (stage === DownloadStage.MERGING) {
            // Manifest merging progress: progress bar restarts at 0% and goes to 100%
            const message =
              downloadState.progress.message || "Merging streams...";
            // Progress bar starts fresh at 0% for merging phase
            const mergingPercentage = Math.min(Math.max(percentage, 0), 100);

            progressBar = `
            <div class="manifest-progress-container">
              <div class="manifest-progress-bar-wrapper">
                <div class="manifest-progress-bar" style="width: ${mergingPercentage}%"></div>
              </div>
              <div class="manifest-progress-info">
                <span class="manifest-progress-size">${message}</span>
                <span class="manifest-progress-speed">${Math.round(
                  mergingPercentage,
                )}%</span>
              </div>
            </div>
          `;
          }
        } else {
          // Direct download: show animated dots and file size (existing behavior)
          const fileSize = downloadState.progress.total;
          const fileSizeText = fileSize ? formatFileSize(fileSize) : "";

          progressBar = `
          <div class="downloading-label">
            <span class="downloading-dots">
              <span class="dot">.</span><span class="dot">.</span><span class="dot">.</span>
            </span>
            ${
              fileSizeText
                ? `<span class="file-size">${fileSizeText}</span>`
                : ""
            }
          </div>
        `;
        }

        // Hide button while downloading
        buttonText = "";
        buttonDisabled = true;
      } else if (isCompleted) {
        statusBadge = `<span class="video-status status-completed">Completed</span>`;
        buttonText = "Redownload";
        buttonDisabled = false; // Allow redownloading
      } else if (isFailed) {
        statusBadge = `<span class="video-status status-failed">Failed</span>`;
        buttonText = "Retry";
      }

      return `
    <div class="video-item">
      <div class="video-item-preview">
        ${
          video.thumbnail
            ? `
          <img src="${escapeHtml(video.thumbnail)}" 
               alt="Video preview" 
               onerror="this.parentElement.innerHTML='<div class=\\'no-thumbnail\\'>🎬</div>'"
               loading="lazy">
        `
            : `
          <div class="no-thumbnail">🎬</div>
        `
        }
      </div>
      <div class="video-item-content">
        <div class="video-item-header">
          <div class="video-item-title" title="${escapeHtml(video.url)}">
            ${escapeHtml(video.title || getVideoTitleFromUrl(video.url))}
          </div>
          ${statusBadge}
        </div>
        <div class="video-meta">
          ${
            displayResolution
              ? `<span class="video-resolution">${escapeHtml(
                  displayResolution,
                )}</span>`
              : ""
          }
          ${
            displayDimensions
              ? `<span class="video-resolution">${displayDimensions}</span>`
              : ""
          }
          <span class="video-link-type">${escapeHtml(
            getLinkTypeDisplayName(video.format),
          )}</span>
          <span class="video-format">${escapeHtml(
            getFormatDisplayName(video.format, actualFormat),
          )}</span>
          ${
            video.duration
              ? `<span style="color: #999; margin-left: 4px;">⏱ ${formatDuration(
                  video.duration,
                )}</span>`
              : ""
          }
        </div>
        <div style="font-size: 11px; color: #b0b0b0; margin-top: 4px;">
          From: ${escapeHtml(new URL(video.pageUrl).hostname)}
        </div>
        ${progressBar}
        ${
          !isDownloading
            ? `
          <div style="display: flex; gap: 6px; margin-top: 6px;">
            <button class="video-btn ${buttonDisabled ? "disabled" : ""}" 
                    data-url="${escapeHtml(video.url)}" 
                    ${buttonDisabled ? "disabled" : ""}>
              ${buttonText}
            </button>
            ${
              (video.format === "hls" || video.format === "m3u8")
                ? `
              <button class="video-btn-manifest" 
                      data-url="${escapeHtml(video.url)}" 
                      title="Select quality">
                Select Quality
              </button>
            `
                : ""
            }
          </div>
        `
            : ""
        }
      </div>
    </div>
  `;
    })
    .join("");

  // Add click handlers for download buttons
  detectedVideosList.querySelectorAll(".video-btn").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      const button = e.target as HTMLButtonElement;
      if (button.disabled) return;
      const url = button.getAttribute("data-url")!;
      const normalizedUrl = normalizeUrl(url);
      const videoMetadata = detectedVideos[normalizedUrl];
      startDownload(url, videoMetadata, { triggerButton: button });
    });
  });

  // Add click handlers for manifest quality selection buttons
  detectedVideosList.querySelectorAll(".video-btn-manifest").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      const button = e.target as HTMLButtonElement;
      const url = button.getAttribute("data-url")!;
      handleSendToManifestTab(url);
    });
  });
}

/**
 * Render downloads list (in-progress and completed)
 */
function renderDownloads() {
  if (!downloadsList) return;

  // Separate downloads into in-progress and completed
  const inProgress = downloadStates.filter(
    (d) =>
      d.progress.stage !== DownloadStage.COMPLETED &&
      d.progress.stage !== DownloadStage.FAILED &&
      d.progress.stage !== DownloadStage.CANCELLED,
  );
  const completed = downloadStates.filter(
    (d) => d.progress.stage === DownloadStage.COMPLETED,
  );
  const failed = downloadStates.filter(
    (d) => d.progress.stage === DownloadStage.FAILED || d.progress.stage === DownloadStage.CANCELLED,
  );

  // Sort by updatedAt (most recent first)
  inProgress.sort((a, b) => b.updatedAt - a.updatedAt);
  completed.sort((a, b) => b.updatedAt - a.updatedAt);
  failed.sort((a, b) => b.updatedAt - a.updatedAt);

  if (inProgress.length === 0 && completed.length === 0 && failed.length === 0) {
    downloadsList.innerHTML = `
      <div class="empty-state">
        No downloads yet.<br>
        Start downloading videos from the Videos tab.
      </div>
    `;
    return;
  }

  let html = "";

  // Render in-progress downloads
  if (inProgress.length > 0) {
    html += `<div style="margin-bottom: 16px;">
      <div style="font-size: 12px; font-weight: 600; color: var(--text-secondary); margin-bottom: 8px; text-transform: uppercase; letter-spacing: 0.5px;">
        In Progress (${inProgress.length})
      </div>`;

    inProgress.forEach((download) => {
      html += renderDownloadItem(download);
    });

    html += `</div>`;
  }

  // Render completed downloads
  if (completed.length > 0) {
    html += `<div style="margin-bottom: 16px;">
      <div style="font-size: 12px; font-weight: 600; color: var(--text-secondary); margin-bottom: 8px; text-transform: uppercase; letter-spacing: 0.5px;">
        Completed (${completed.length})
      </div>`;

    completed.forEach((download) => {
      html += renderDownloadItem(download);
    });

    html += `</div>`;
  }

  // Render failed downloads
  if (failed.length > 0) {
    html += `<div style="margin-bottom: 16px;">
      <div style="font-size: 12px; font-weight: 600; color: var(--text-secondary); margin-bottom: 8px; text-transform: uppercase; letter-spacing: 0.5px;">
        Failed (${failed.length})
      </div>`;

    failed.forEach((download) => {
      html += renderDownloadItem(download);
    });

    html += `</div>`;
  }

  downloadsList.innerHTML = html;

  // Add event listeners for buttons
  downloadsList.querySelectorAll(".download-open-btn").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      const button = e.target as HTMLButtonElement;
      const downloadId = button.getAttribute("data-download-id")!;
      await handleOpenDownload(downloadId);
    });
  });

  downloadsList.querySelectorAll(".download-remove-btn").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation(); // Prevent event from bubbling to other handlers
      const button = e.target as HTMLButtonElement;
      const downloadId = button.getAttribute("data-download-id");
      if (downloadId) {
        await handleRemoveDownload(downloadId);
      }
    });
  });

  downloadsList.querySelectorAll(".download-retry-btn").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      const button = e.target as HTMLButtonElement;
      const downloadId = button.getAttribute("data-download-id")!;
      await handleRetryDownload(downloadId);
    });
  });
}

/**
 * Render a single download item
 */
function renderDownloadItem(download: DownloadState): string {
  const isInProgress =
    download.progress.stage !== DownloadStage.COMPLETED &&
    download.progress.stage !== DownloadStage.FAILED &&
    download.progress.stage !== DownloadStage.CANCELLED;
  const isCompleted = download.progress.stage === DownloadStage.COMPLETED;
  const isFailed =
    download.progress.stage === DownloadStage.FAILED ||
    download.progress.stage === DownloadStage.CANCELLED;
  const isCancelled = download.progress.stage === DownloadStage.CANCELLED;

  const title =
    download.metadata.title ||
    getVideoTitleFromUrl(download.metadata.url);
  const stage = download.progress.stage;
  const statusBadge = `<span class="video-status status-${stage}">${getStatusText(
    stage,
  )}</span>`;

  let progressBar = "";
  const isManifestDownload =
    (download.metadata.format === "hls" ||
      download.metadata.format === "m3u8") &&
    (stage === DownloadStage.DOWNLOADING || stage === DownloadStage.MERGING);

  if (isInProgress && isManifestDownload) {
    const percentage = download.progress.percentage || 0;

    if (stage === DownloadStage.DOWNLOADING) {
      const downloaded = download.progress.downloaded || 0;
      const total = download.progress.total || 0;
      const speed = download.progress.speed || 0;

      const downloadedText = formatFileSize(downloaded);
      const totalText = total > 0 ? formatFileSize(total) : "?";
      const speedText = formatSpeed(speed);

      progressBar = `
        <div class="manifest-progress-container">
          <div class="manifest-progress-bar-wrapper">
            <div class="manifest-progress-bar" style="width: ${Math.min(
              percentage,
              100,
            )}%"></div>
          </div>
          <div class="manifest-progress-info">
            <span class="manifest-progress-size">${downloadedText} / ${totalText}</span>
            ${
              speed > 0
                ? `<span class="manifest-progress-speed">${speedText}</span>`
                : ""
            }
          </div>
        </div>
      `;
    } else if (stage === DownloadStage.MERGING) {
      const message = download.progress.message || "Merging streams...";
      const mergingPercentage = Math.min(Math.max(percentage, 0), 100);

      progressBar = `
        <div class="manifest-progress-container">
          <div class="manifest-progress-bar-wrapper">
            <div class="manifest-progress-bar" style="width: ${mergingPercentage}%"></div>
          </div>
          <div class="manifest-progress-info">
            <span class="manifest-progress-size">${message}</span>
            <span class="manifest-progress-speed">${Math.round(
              mergingPercentage,
            )}%</span>
          </div>
        </div>
      `;
    }
  } else if (isInProgress) {
    const fileSize = download.progress.total;
    const fileSizeText = fileSize ? formatFileSize(fileSize) : "";

    progressBar = `
      <div class="downloading-label">
        <span class="downloading-dots">
          <span class="dot">.</span><span class="dot">.</span><span class="dot">.</span>
        </span>
        ${fileSizeText ? `<span class="file-size">${fileSizeText}</span>` : ""}
      </div>
    `;
  }

  const displayResolution = (download.metadata.resolution || "").trim();
  const displayWidth = download.metadata.width;
  const displayHeight = download.metadata.height;
  const displayDimensions =
    !displayResolution && displayWidth && displayHeight
      ? `${displayWidth}x${displayHeight}`
      : "";

  const actualFormat = getActualFileFormat(download.metadata, download);

  // Format date
  const date = new Date(download.updatedAt);
  const dateText = date.toLocaleDateString() + " " + date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  let actionButtons = "";
  if (isCompleted && download.localPath) {
    actionButtons = `
      <div style="display: flex; gap: 6px; margin-top: 6px;">
        <button class="video-btn download-open-btn" data-download-id="${download.id}">
          Open File
        </button>
        <button class="video-btn download-remove-btn" data-download-id="${download.id}">
          Remove
        </button>
      </div>
    `;
  } else if (isFailed) {
    actionButtons = `
      <div style="display: flex; gap: 6px; margin-top: 6px;">
        <button class="video-btn download-retry-btn" data-download-id="${download.id}">
          Retry
        </button>
        <button class="video-btn download-remove-btn" data-download-id="${download.id}">
          Remove
        </button>
      </div>
    `;
  } else if (isInProgress) {
    // Check if download can be cancelled based on its current stage
    if (!canCancelDownload(download.progress.stage)) {
      actionButtons = `
        <div style="display: flex; gap: 6px; margin-top: 6px;">
          <button class="video-btn download-remove-btn" data-download-id="${download.id}" disabled title="${CANNOT_CANCEL_MESSAGE}" style="opacity: 0.6; cursor: not-allowed;">
            Cancel
          </button>
        </div>
        <div style="font-size: 11px; color: #888; margin-top: 4px;">
          Cannot cancel: Chunks downloaded, merging in progress
        </div>
      `;
    } else {
      actionButtons = `
        <div style="display: flex; gap: 6px; margin-top: 6px;">
          <button class="video-btn download-remove-btn" data-download-id="${download.id}">
            Cancel
          </button>
        </div>
      `;
    }
  }

  return `
    <div class="download-item">
      <div class="video-item-preview">
        ${
          download.metadata.thumbnail
            ? `
          <img src="${escapeHtml(download.metadata.thumbnail)}" 
               alt="Video preview" 
               onerror="this.parentElement.innerHTML='<div class=\\'no-thumbnail\\'>🎬</div>'"
               loading="lazy">
        `
            : `
          <div class="no-thumbnail">🎬</div>
        `
        }
      </div>
      <div class="video-item-content">
        <div class="download-item-header">
          <div class="download-item-title" title="${escapeHtml(
            download.metadata.url,
          )}">
            ${escapeHtml(title)}
          </div>
          ${statusBadge}
        </div>
        <div class="video-meta">
          ${
            displayResolution
              ? `<span class="video-resolution">${escapeHtml(
                  displayResolution,
                )}</span>`
              : ""
          }
          ${
            displayDimensions
              ? `<span class="video-resolution">${displayDimensions}</span>`
              : ""
          }
          <span class="video-link-type">${escapeHtml(
            getLinkTypeDisplayName(download.metadata.format),
          )}</span>
          <span class="video-format">${escapeHtml(
            getFormatDisplayName(download.metadata.format, actualFormat),
          )}</span>
          ${
            download.metadata.duration
              ? `<span style="color: #999; margin-left: 4px;">⏱ ${formatDuration(
                  download.metadata.duration,
                )}</span>`
              : ""
          }
        </div>
        <div style="font-size: 11px; color: var(--text-secondary); margin-top: 4px;">
          ${dateText}
        </div>
        ${progressBar}
        ${actionButtons}
      </div>
    </div>
  `;
}

/**
 * Handle opening a downloaded file
 */
async function handleOpenDownload(downloadId: string) {
  try {
    const download = await getDownload(downloadId);
    if (!download || !download.localPath) {
      alert("Download file not found");
      return;
    }

    // Use chrome.downloads API to open the file
    // First, we need to find the download item by filename
    const filename = download.localPath.split(/[/\\]/).pop();
    if (!filename) {
      alert("Could not determine filename");
      return;
    }

    // Search for the download item
    const downloads = await new Promise<chrome.downloads.DownloadItem[]>(
      (resolve) => {
        chrome.downloads.search({ filenameRegex: filename }, resolve);
      },
    );

    if (downloads.length > 0) {
      // Open the most recent matching download
      chrome.downloads.show(downloads[0].id);
    } else {
      // Fallback: try to open the folder
      await chrome.downloads.showDefaultFolder();
    }
  } catch (error) {
    console.error("Failed to open download:", error);
    alert("Failed to open download file");
  }
}

/**
 * Handle removing a download
 */
async function handleRemoveDownload(downloadId: string) {
  try {
    const download = await getDownload(downloadId);
    if (!download) {
      return;
    }

    const isInProgress =
      download.progress.stage !== DownloadStage.COMPLETED &&
      download.progress.stage !== DownloadStage.FAILED &&
      download.progress.stage !== DownloadStage.CANCELLED;

    if (isInProgress) {
      // Check if download can be cancelled based on its current stage
      if (!canCancelDownload(download.progress.stage)) {
        alert(CANNOT_CANCEL_MESSAGE);
        return;
      }

      // Cancel the download if it's in progress
      if (!confirm("Are you sure you want to cancel this download?")) {
        return;
      }

      try {
        const response = await new Promise<any>((resolve, reject) => {
          chrome.runtime.sendMessage(
            {
              type: MessageType.CANCEL_DOWNLOAD,
              payload: { id: downloadId },
            },
            (response) => {
              if (chrome.runtime.lastError) {
                reject(new Error(chrome.runtime.lastError.message));
                return;
              }
              resolve(response);
            },
          );
        });

        if (response && response.success) {
          await loadDownloadStates();
          renderDownloads();
          // Refresh detected videos list to show video card in initial state
          renderDetectedVideos();
        } else if (response && response.error) {
          alert(response.error);
        }
      } catch (error: any) {
        console.error("Failed to cancel download:", error);
        alert("Failed to cancel download: " + (error?.message || "Unknown error"));
      }
    } else {
      // Remove completed or failed download
      if (!confirm("Are you sure you want to remove this download?")) {
        return;
      }

      await deleteDownload(downloadId);
      await loadDownloadStates();
      renderDownloads();
    }
  } catch (error) {
    console.error("Failed to remove download:", error);
    alert("Failed to remove download");
  }
}

/**
 * Handle retrying a failed download
 */
async function handleRetryDownload(downloadId: string) {
  try {
    const download = await getDownload(downloadId);
    if (!download) {
      alert("Download not found");
      return;
    }

    // Use original download's metadata for filename generation
    // Extract website from pageUrl, otherwise from video URL
    let website: string | undefined;
    try {
      const urlObj = new URL(download.metadata.pageUrl);
      website = urlObj.hostname.replace(/^www\./, "");
    } catch {
      // If pageUrl parsing fails, fall back to video URL
      if (download.url) {
        try {
          const urlObj = new URL(download.url);
          website = urlObj.hostname.replace(/^www\./, "");
        } catch {
          // Ignore URL parsing errors
        }
      }
    }

    // Use metadata title as tabTitle for filename generation
    const tabTitle = download.metadata.title;

    // Remove the failed download state
    await deleteDownload(downloadId);

    // Start a new download with the same metadata
    const response = await new Promise<any>((resolve, reject) => {
      chrome.runtime.sendMessage(
        {
          type: MessageType.DOWNLOAD_REQUEST,
          payload: {
            url: download.url,
            metadata: download.metadata,
            tabTitle,
            website,
          },
        },
        (response) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
            return;
          }
          resolve(response);
        },
      );
    });

    if (response && response.success) {
      await loadDownloadStates();
      renderDownloads();
    } else if (response && response.error) {
      alert(response.error);
    }
  } catch (error: any) {
    console.error("Failed to retry download:", error);
    alert("Failed to retry download: " + (error?.message || "Unknown error"));
  }
}
/**
 * Start download for a video URL
 */
async function startDownload(
  url: string,
  videoMetadata?: VideoMetadata,
  options: { triggerButton?: HTMLButtonElement } = {},
) {
  const triggerButton = options.triggerButton;
  const originalText = triggerButton?.textContent;
  if (triggerButton) {
    triggerButton.disabled = true;
    triggerButton.classList.add("disabled");
    triggerButton.textContent = "Starting...";
  }

  let shouldResetButton = false;

  try {
    // Check if extension context is still valid before sending
    if (chrome.runtime.lastError) {
      if (
        chrome.runtime.lastError.message?.includes(
          "Extension context invalidated",
        )
      ) {
        alert(
          "Extension was reloaded. Please refresh this page and try again.",
        );
        shouldResetButton = true;
        return;
      }
    }

    // Get current tab information for filename
    let tabTitle: string | undefined;
    let website: string | undefined;
    try {
      const [tab] = await chrome.tabs.query({
        active: true,
        currentWindow: true,
      });
      if (tab) {
        tabTitle = tab.title || undefined;
        if (tab.url) {
          try {
            const urlObj = new URL(tab.url);
            website = urlObj.hostname.replace(/^www\./, ""); // Remove www. prefix
          } catch {
            // Ignore URL parsing errors
          }
        }
      }
    } catch (error) {
      // Ignore errors getting tab info, will use fallback
      console.debug("Could not get tab information:", error);
    }

    const response = await new Promise<any>((resolve, reject) => {
      chrome.runtime.sendMessage(
        {
          type: MessageType.DOWNLOAD_REQUEST,
          payload: {
            url,
            metadata: videoMetadata,
            tabTitle,
            website,
          },
        },
        (response) => {
          if (chrome.runtime.lastError) {
            const errorMessage = chrome.runtime.lastError.message || "";
            if (errorMessage.includes("Extension context invalidated")) {
              reject(
                new Error(
                  "Extension context invalidated. Please reload the extension and try again.",
                ),
              );
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
    }).catch((error: any) => {
      if (error?.message?.includes("Extension context invalidated")) {
        throw new Error(
          "Extension context invalidated. Please reload the extension and try again.",
        );
      }
      throw error;
    });

    if (response && response.success) {
      await loadDownloadStates();
      renderDetectedVideos();
    } else if (response && response.error) {
      const errorMessage = response.error;
      if (
        !errorMessage.includes("already") &&
        !errorMessage.includes("in progress")
      ) {
        alert(response.error);
      }
      await loadDownloadStates();
      renderDetectedVideos();
      shouldResetButton = true;
    }
  } catch (error: any) {
    console.error("Download request failed:", error);
    // Check if error is due to invalidated context
    if (
      error?.message?.includes("Extension context invalidated") ||
      chrome.runtime.lastError?.message?.includes(
        "Extension context invalidated",
      )
    ) {
      alert(
        "Extension was reloaded. Please close and reopen this popup, then try again.",
      );
    } else {
      alert("Failed to start download: " + (error?.message || "Unknown error"));
    }
    shouldResetButton = true;
  } finally {
    if (shouldResetButton && triggerButton && triggerButton.isConnected) {
      triggerButton.disabled = false;
      triggerButton.classList.remove("disabled");
      triggerButton.textContent = originalText || "Download";
    }
  }
}

/**
 * Get video title from URL
 */
function getVideoTitleFromUrl(url: string): string {
  try {
    const urlObj = new URL(url);
    const pathname = urlObj.pathname;
    const filename = pathname.split("/").pop();
    return filename || url.substring(0, 50) + "...";
  } catch {
    return url.substring(0, 50) + "...";
  }
}

/**
 * Get status text
 */
function getStatusText(stage: DownloadStage): string {
  const statusMap: Record<DownloadStage, string> = {
    [DownloadStage.DETECTING]: "Detecting",
    [DownloadStage.DOWNLOADING]: "Downloading",
    [DownloadStage.MERGING]: "Merging",
    [DownloadStage.SAVING]: "Saving",
    [DownloadStage.UPLOADING]: "Uploading",
    [DownloadStage.COMPLETED]: "Completed",
    [DownloadStage.FAILED]: "Failed",
    [DownloadStage.CANCELLED]: "Cancelled",
  };

  return statusMap[stage] || stage;
}

/**
 * Get actual file format from video URL or download state
 */
function getActualFileFormat(
  video: VideoMetadata,
  downloadState?: DownloadState,
): string | null {
  // First, check if download is completed and we have the local path
  if (downloadState?.localPath) {
    const ext = downloadState.localPath.split(".").pop()?.toUpperCase();
    if (
      ext &&
      ["MP4", "WEBM", "MOV", "AVI", "MKV", "FLV", "WMV", "OGG"].includes(ext)
    ) {
      return ext;
    }
  }

  // Check video URL for file extension
  try {
    const url = new URL(video.url);
    const pathname = url.pathname.toLowerCase();
    const extensionMatch = pathname.match(
      /\.(mp4|webm|mov|avi|mkv|flv|wmv|ogg)(\?|$|#)/,
    );
    if (extensionMatch && extensionMatch[1]) {
      return extensionMatch[1].toUpperCase();
    }
  } catch {
    // URL parsing failed, try simple string match
    const urlLower = video.url.toLowerCase();
    const extensionMatch = urlLower.match(
      /\.(mp4|webm|mov|avi|mkv|flv|wmv|ogg)(\?|$|#)/,
    );
    if (extensionMatch && extensionMatch[1]) {
      return extensionMatch[1].toUpperCase();
    }
  }

  return null;
}

/**
 * Get format display name - show actual file format instead of delivery method
 */
function getFormatDisplayName(
  format: VideoFormat,
  actualFormat?: string | null,
): string {
  // If we have the actual file format, use it
  if (actualFormat) {
    return actualFormat;
  }

  // When format is "direct", it means it's a direct video file download
  // Default to MP4 if we can't determine the actual format
  if (format === "direct") {
    return "MP4";
  }

  return format.toUpperCase();
}

/**
 * Get link type display name (delivery method: direct, etc.)
 */
function getLinkTypeDisplayName(format: VideoFormat): string {
  switch (format) {
    case "direct":
      return "Direct";
    default:
      return format.charAt(0).toUpperCase() + format.slice(1);
  }
}

/**
 * Format duration in seconds to readable format
 */
function formatDuration(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);

  if (hours > 0) {
    return `${hours}:${minutes.toString().padStart(2, "0")}:${secs
      .toString()
      .padStart(2, "0")}`;
  }
  return `${minutes}:${secs.toString().padStart(2, "0")}`;
}

/**
 * Format file size in bytes to readable format
 */
function formatFileSize(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes.toFixed(0)} B`;
  } else if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  } else if (bytes < 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  } else {
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  }
}

/**
 * Format download speed in bytes per second to readable format
 */
function formatSpeed(bytesPerSecond: number): string {
  if (bytesPerSecond < 1024) {
    return `${bytesPerSecond.toFixed(0)} B/s`;
  } else if (bytesPerSecond < 1024 * 1024) {
    return `${(bytesPerSecond / 1024).toFixed(1)} KB/s`;
  } else if (bytesPerSecond < 1024 * 1024 * 1024) {
    return `${(bytesPerSecond / (1024 * 1024)).toFixed(1)} MB/s`;
  } else {
    return `${(bytesPerSecond / (1024 * 1024 * 1024)).toFixed(2)} GB/s`;
  }
}

/**
 * Escape HTML
 */
function escapeHtml(text: string): string {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

/**
 * Fetch text from URL using background script (for CORS)
 */
async function fetchTextViaBackground(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(
      {
        type: MessageType.FETCH_RESOURCE,
        payload: {
          input: url,
          init: {
            method: "GET",
          },
        },
      },
      (response: [any, Error | null] | undefined) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        if (!response) {
          reject(new Error("No response from background script"));
          return;
        }
        const [res, error] = response;
        if (error) {
          reject(error);
          return;
        }
        if (res && res.status === 200 && res.body) {
          // Convert array of bytes to string
          const bytes = new Uint8Array(res.body);
          const text = new TextDecoder().decode(bytes);
          resolve(text);
        } else {
          reject(
            new Error(`Failed to fetch: ${res?.status || "unknown status"}`),
          );
        }
      },
    );
  });
}

/**
 * Format quality label for display
 */
function formatQualityLabel(level: Level): string {
  const parts: string[] = [];

  if (level.height) {
    parts.push(`${level.height}p`);
  } else if (level.width && level.height) {
    parts.push(`${level.width}x${level.height}`);
  }

  if (level.bitrate) {
    const bitrateMbps = (level.bitrate / 1000000).toFixed(2);
    parts.push(`${bitrateMbps} Mbps`);
  }

  if (level.fps) {
    parts.push(`${level.fps} fps`);
  }

  return parts.length > 0 ? parts.join(" • ") : "Unknown";
}

/**
 * Switch between tabs
 */
async function switchTab(tabName: "auto" | "manual" | "downloads") {
  if (tabName === "auto") {
    if (autoDetectTab) autoDetectTab.classList.add("active");
    if (manifestTab) manifestTab.classList.remove("active");
    if (downloadsTab) downloadsTab.classList.remove("active");
    if (autoDetectContent) autoDetectContent.classList.add("active");
    if (manifestContent) manifestContent.classList.remove("active");
    if (downloadsContent) downloadsContent.classList.remove("active");
  } else if (tabName === "manual") {
    if (autoDetectTab) autoDetectTab.classList.remove("active");
    if (manifestTab) manifestTab.classList.add("active");
    if (downloadsTab) downloadsTab.classList.remove("active");
    if (autoDetectContent) autoDetectContent.classList.remove("active");
    if (manifestContent) manifestContent.classList.add("active");
    if (downloadsContent) downloadsContent.classList.remove("active");

    // Update form state when switching to manual tab
    updateManualManifestFormState();
  } else if (tabName === "downloads") {
    if (autoDetectTab) autoDetectTab.classList.remove("active");
    if (manifestTab) manifestTab.classList.remove("active");
    if (downloadsTab) downloadsTab.classList.add("active");
    if (autoDetectContent) autoDetectContent.classList.remove("active");
    if (manifestContent) manifestContent.classList.remove("active");
    if (downloadsContent) downloadsContent.classList.add("active");

    // Refresh downloads when switching to downloads tab
    await loadDownloadStates();
    renderDownloads();
  }
}

/**
 * Update manual manifest form state based on download status and selections
 */
function updateManualManifestFormState() {
  let isDownloading = false;

  // Check if there's an active download
  if (currentManualManifestUrl) {
    const normalizedUrl = normalizeUrl(currentManualManifestUrl);
    const downloadState = downloadStates.find((d) => {
      if (!d.metadata) return false;
      return normalizeUrl(d.metadata.url) === normalizedUrl;
    });

    if (downloadState) {
      isDownloading =
        downloadState.progress.stage !== DownloadStage.COMPLETED &&
        downloadState.progress.stage !== DownloadStage.FAILED;
    }
  }

  // Update form elements based on download status
  if (manifestUrlInput) manifestUrlInput.disabled = isDownloading;
  if (loadManifestPlaylistBtn) loadManifestPlaylistBtn.disabled = isDownloading;
  if (videoQualitySelect) {
    videoQualitySelect.disabled =
      isDownloading || videoQualitySelect.options.length <= 1;
  }
  if (audioQualitySelect) {
    audioQualitySelect.disabled =
      isDownloading || audioQualitySelect.options.length <= 1;
  }

  // Update download button state
  if (!startManifestDownloadBtn) return;

  // Disable button while downloading
  if (isDownloading) {
    startManifestDownloadBtn.disabled = true;
    return;
  }

  // If it's a media playlist, button is enabled after loading
  if (isMediaPlaylistMode) {
    startManifestDownloadBtn.disabled = false;
    return;
  }

  // For master playlists, check if at least one quality is selected
  if (!videoQualitySelect || !audioQualitySelect) {
    startManifestDownloadBtn.disabled = true;
    return;
  }

  const videoSelected = videoQualitySelect.value !== "";
  const audioSelected = audioQualitySelect.value !== "";

  // Enable button if at least one quality is selected
  startManifestDownloadBtn.disabled = !(videoSelected || audioSelected);
}

/**
 * Handle Load manifest button click
 */
async function handleLoadManifestPlaylist() {
  if (!manifestUrlInput || !loadManifestPlaylistBtn) return;

  const rawUrl = manifestUrlInput.value.trim();

  if (!rawUrl) {
    alert("Please enter a manifest URL");
    return;
  }

  // Normalize URL first
  const normalizedUrl = normalizeUrl(rawUrl);

  // Use format detector to check if it's a manifest URL (same as detection uses)
  const format = detectFormatFromUrl(normalizedUrl);
  if (format !== "hls") {
    alert("Please enter a valid manifest URL (.m3u8 or .mpd)");
    return;
  }

  // Update input with normalized URL
  manifestUrlInput.value = normalizedUrl;

  // Show loading state
  loadManifestPlaylistBtn.disabled = true;
  loadManifestPlaylistBtn.textContent = "Loading...";

  // Hide previous states
  if (manifestMediaPlaylistWarning) {
    manifestMediaPlaylistWarning.style.display = "none";
  }
  if (manifestQualitySelection) {
    manifestQualitySelection.style.display = "none";
  }

  try {
    // Fetch playlist using normalized URL
    const playlistText = await fetchTextViaBackground(normalizedUrl);

    // Check if it's a media playlist or master playlist
    if (isMediaPlaylist(playlistText)) {
      // It's a media playlist - show warning and enable download
      isMediaPlaylistMode = true;
      if (manifestMediaPlaylistWarning) {
        manifestMediaPlaylistWarning.style.display = "block";
      }
      if (manifestQualitySelection) {
        manifestQualitySelection.style.display = "none";
      }
    } else if (isMasterPlaylist(playlistText)) {
      // It's a master playlist - show quality selection
      isMediaPlaylistMode = false;
      if (manifestMediaPlaylistWarning) {
        manifestMediaPlaylistWarning.style.display = "none";
      }
      if (manifestQualitySelection && videoQualitySelect && audioQualitySelect) {
        manifestQualitySelection.style.display = "block";

        // Parse master playlist using normalized URL
        const levels = parseMasterPlaylist(playlistText, normalizedUrl);

        // Separate video and audio levels
        const videoLevels = levels.filter((level) => level.type === "stream");
        const audioLevels = levels.filter((level) => level.type === "audio");

        // Populate video quality select (we've already checked it's not null)
        if (videoQualitySelect) {
          videoQualitySelect.innerHTML =
            '<option value="">None (audio only)</option>';
          videoLevels.forEach((level, index) => {
            const option = document.createElement("option");
            option.value = level.uri;
            option.textContent = formatQualityLabel(level);
            option.setAttribute("data-level-index", index.toString());
            videoQualitySelect!.appendChild(option);
          });
          videoQualitySelect.disabled = false;
        }

        // Populate audio quality select (we've already checked it's not null)
        if (audioQualitySelect) {
          audioQualitySelect.innerHTML =
            '<option value="">None (video only)</option>';
          audioLevels.forEach((level, index) => {
            const option = document.createElement("option");
            option.value = level.uri;
            option.textContent = level.id;
            option.setAttribute("data-level-index", index.toString());
            audioQualitySelect!.appendChild(option);
          });
          audioQualitySelect.disabled = false;
        }

        // Auto-select first options if available
        if (
          videoLevels.length > 0 &&
          videoQualitySelect &&
          videoQualitySelect.options.length > 1
        ) {
          videoQualitySelect.selectedIndex = 1;
        }
        if (
          audioLevels.length > 0 &&
          audioQualitySelect &&
          audioQualitySelect.options.length > 1
        ) {
          audioQualitySelect.selectedIndex = 1;
        }

        updateDownloadButtonState();
      }
    } else {
      throw new Error("Invalid playlist format");
    }

    // Update form state after loading playlist
    updateManualManifestFormState();
  } catch (error) {
    console.error("Failed to load manifest:", error);
    alert("Failed to load manifest. Please check the URL and try again.");
    if (manifestMediaPlaylistWarning) {
      manifestMediaPlaylistWarning.style.display = "none";
    }
    if (manifestQualitySelection) {
      manifestQualitySelection.style.display = "none";
    }
    // Update form state on error
    updateManualManifestFormState();
  } finally {
    if (loadManifestPlaylistBtn) {
      loadManifestPlaylistBtn.disabled = false;
      loadManifestPlaylistBtn.textContent = "Load";
    }
  }
}

/**
 * Update download button state based on selections
 * This is now a wrapper that calls updateManualManifestFormState for consistency
 */
function updateDownloadButtonState() {
  updateManualManifestFormState();
}

/**
 * Handle sending video from autodetect to manifest tab for quality selection
 */
async function handleSendToManifestTab(url: string) {
  // Switch to manifest tab
  await switchTab("manual");

  // Wait a bit for the tab to switch and DOM to be ready
  await new Promise((resolve) => setTimeout(resolve, 100));

  // Fill the manifest URL input with the video URL
  if (manifestUrlInput) {
    manifestUrlInput.value = url;
  }

  // Automatically load the playlist
  await handleLoadManifestPlaylist();
}

/**
 * Handle start manifest download
 */
async function handleStartManifestDownload() {
  if (!manifestUrlInput || !startManifestDownloadBtn) return;

  const rawPlaylistUrl = manifestUrlInput.value.trim();

  if (!rawPlaylistUrl) {
    alert("Please enter a manifest URL");
    return;
  }

  // Normalize URL first
  const playlistUrl = normalizeUrl(rawPlaylistUrl);

  // For media playlists, download directly without quality selection
  // For master playlists, use selected qualities
  let videoPlaylistUrl: string | null = null;
  let audioPlaylistUrl: string | null = null;

  if (!isMediaPlaylistMode) {
    // Master playlist - use selected qualities
    if (!videoQualitySelect || !audioQualitySelect) return;

    const rawVideoUrl = videoQualitySelect.value || null;
    const rawAudioUrl = audioQualitySelect.value || null;

    // Normalize selected quality URLs
    videoPlaylistUrl = rawVideoUrl ? normalizeUrl(rawVideoUrl) : null;
    audioPlaylistUrl = rawAudioUrl ? normalizeUrl(rawAudioUrl) : null;

    if (!videoPlaylistUrl && !audioPlaylistUrl) {
      alert("Please select at least one quality (video or audio)");
      return;
    }
  }
  // For media playlists, we don't set videoPlaylistUrl or audioPlaylistUrl
  // The URL will be passed directly and handled by the m3u8 download handler

  // Update button text and disable form elements
  startManifestDownloadBtn.textContent = "Starting...";

  // Disable form inputs during download (will be managed by updateManualManifestFormState after setting currentManualManifestUrl)
  // But we need to disable immediately before the download starts
  if (manifestUrlInput) manifestUrlInput.disabled = true;
  if (loadManifestPlaylistBtn) loadManifestPlaylistBtn.disabled = true;
  if (videoQualitySelect) videoQualitySelect.disabled = true;
  if (audioQualitySelect) audioQualitySelect.disabled = true;
  startManifestDownloadBtn.disabled = true;

  try {
    // Get current tab information for filename
    let tabTitle: string | undefined;
    let website: string | undefined;
    let pageUrl: string = "";
    try {
      const [tab] = await chrome.tabs.query({
        active: true,
        currentWindow: true,
      });
      if (tab) {
        tabTitle = tab.title || undefined;
        if (tab.url) {
          pageUrl = tab.url;
          try {
            const urlObj = new URL(tab.url);
            website = urlObj.hostname.replace(/^www\./, "");
          } catch {
            // Ignore URL parsing errors
          }
        }
      }
    } catch (error) {
      // Ignore errors getting tab info
      console.debug("Could not get tab information:", error);
    }

    // Create video metadata
    const metadata: VideoMetadata = {
      url: playlistUrl,
      format: isMediaPlaylistMode ? "m3u8" : "hls",
      title: tabTitle || "Manifest Video",
      pageUrl: pageUrl || window.location.href,
    };

    // Send download request with quality preferences
    const response = await new Promise<any>((resolve, reject) => {
      chrome.runtime.sendMessage(
        {
          type: MessageType.DOWNLOAD_REQUEST,
          payload: {
            url: playlistUrl,
            metadata,
            tabTitle,
            website,
            manifestQuality: isMediaPlaylistMode
              ? undefined
              : {
                  videoPlaylistUrl,
                  audioPlaylistUrl,
                },
            isManual: true, // Mark as manual download from manifest tab
          },
        },
        (response) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
            return;
          }
          resolve(response);
        },
      );
    });

    if (response && response.success) {
      // Clear the manual manifest URL so progress is no longer shown in manifest tab
      currentManualManifestUrl = null;
      // Hide progress in manifest tab
      if (manifestProgress) {
        manifestProgress.style.display = "none";
      }
      // Reset button text
      if (startManifestDownloadBtn) {
        startManifestDownloadBtn.textContent = "Download";
      }
      // Reset form state
      updateManualManifestFormState();
      // Load download states and switch to downloads tab
      await loadDownloadStates();
      await switchTab("downloads");
      renderDownloads();
    } else if (response && response.error) {
      alert(response.error);
      startManifestDownloadBtn.textContent = "Download";
      // Re-enable form elements on error
      updateManualManifestFormState();
    }
  } catch (error: any) {
    console.error("Download request failed:", error);
    alert("Failed to start download: " + (error?.message || "Unknown error"));
    startManifestDownloadBtn.textContent = "Download";
    // Re-enable form elements on error
    updateManualManifestFormState();
  }
}

/**
 * Load theme from storage and apply it
 */
async function loadTheme() {
  const theme = await ChromeStorage.get<string>("theme");
  const isLightMode = theme === "light";
  applyTheme(isLightMode);
}

/**
 * Apply theme to the page
 */
function applyTheme(isLightMode: boolean) {
  const root = document.documentElement;
  if (isLightMode) {
    root.classList.add("light-mode");
  } else {
    root.classList.remove("light-mode");
  }
  updateThemeIcon(isLightMode);
}

/**
 * Update theme icon based on current theme
 */
function updateThemeIcon(isLightMode: boolean) {
  if (!themeIcon) return;

  if (isLightMode) {
    // Moon icon for light mode (to switch to dark)
    themeIcon.innerHTML = `
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"></path>
    `;
  } else {
    // Sun icon for dark mode (to switch to light)
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

/**
 * Toggle theme between light and dark
 */
async function toggleTheme() {
  const root = document.documentElement;
  const isLightMode = root.classList.contains("light-mode");
  const newTheme = isLightMode ? "dark" : "light";

  await ChromeStorage.set("theme", newTheme);
  applyTheme(!isLightMode);
}

// Initialize when DOM is ready
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
