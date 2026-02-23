/**
 * Detected videos tab rendering.
 */

import { DownloadState, DownloadStage, VideoMetadata } from "../core/types";
import { normalizeUrl } from "../core/utils/url-utils";
import { MessageType } from "../shared/messages";
import { dom, detectedVideos, downloadStates } from "./state";
import {
  escapeHtml,
  formatDuration,
  formatFileSize,
  formatSpeed,
  getActualFileFormat,
  getDownloadStateForVideo,
  getFormatDisplayName,
  getLinkTypeDisplayName,
  getStatusText,
  getVideoTitleFromUrl,
} from "./utils";
import { startDownload } from "./download-actions";
import { handleSendToManifestTab } from "./render-manifest";

// Incremental rendering state
const renderedVideoCards = new Map<string, HTMLElement>();
let lastVideoSnapshotJson = "";

/**
 * Build a snapshot key for a detected video to detect structural changes.
 */
function videoStructureKey(video: VideoMetadata, downloadState?: DownloadState): string {
  const stage = downloadState?.progress.stage ?? "none";
  return `${video.url}:${video.format}:${stage}:${video.thumbnail ?? ""}:${video.hasDrm}:${video.unsupported}:${video.isLive}`;
}

/**
 * Update only the progress-related elements inside an existing video card.
 * Returns false if expected elements are missing (triggers full rebuild).
 */
function updateVideoCardProgress(card: HTMLElement, video: VideoMetadata): boolean {
  const downloadState = getDownloadStateForVideo(video);
  if (!downloadState) return true; // No download in progress, nothing to update

  const stage = downloadState.progress.stage;
  if (
    stage === DownloadStage.COMPLETED ||
    stage === DownloadStage.FAILED ||
    stage === DownloadStage.CANCELLED
  ) {
    return true; // Terminal states don't need progress updates
  }

  if (stage === DownloadStage.RECORDING) {
    const sizeEl = card.querySelector(".manifest-progress-size");
    if (!sizeEl) return false;
    const segmentsCollected = downloadState.progress.segmentsCollected || 0;
    const downloaded = downloadState.progress.downloaded || 0;
    sizeEl.textContent = `${segmentsCollected} segments \u2022 ${formatFileSize(downloaded)}`;
    return true;
  }

  const isManifestDownload =
    (video.format === "hls" || video.format === "m3u8") &&
    (stage === DownloadStage.DOWNLOADING || stage === DownloadStage.MERGING);

  if (isManifestDownload && stage === DownloadStage.DOWNLOADING) {
    const bar = card.querySelector<HTMLElement>(".manifest-progress-bar");
    const sizeEl = card.querySelector(".manifest-progress-size");
    const speedEl = card.querySelector(".manifest-progress-speed");
    if (!bar || !sizeEl) return false;

    const percentage = downloadState.progress.percentage || 0;
    const downloaded = downloadState.progress.downloaded || 0;
    const total = downloadState.progress.total || 0;
    const speed = downloadState.progress.speed || 0;

    bar.style.width = `${Math.min(percentage, 100)}%`;
    sizeEl.textContent = `${formatFileSize(downloaded)} / ${total > 0 ? formatFileSize(total) : "?"}`;
    if (speedEl) {
      speedEl.textContent = speed > 0 ? formatSpeed(speed) : "";
    }
    return true;
  }

  if (isManifestDownload && stage === DownloadStage.MERGING) {
    const bar = card.querySelector<HTMLElement>(".manifest-progress-bar");
    const sizeEl = card.querySelector(".manifest-progress-size");
    const speedEl = card.querySelector(".manifest-progress-speed");
    if (!bar || !sizeEl) return false;

    const percentage = Math.min(Math.max(downloadState.progress.percentage || 0, 0), 100);
    const message = downloadState.progress.message || "Merging streams...";

    bar.style.width = `${percentage}%`;
    sizeEl.textContent = message;
    if (speedEl) speedEl.textContent = `${Math.round(percentage)}%`;
    return true;
  }

  // Direct/other downloading stages
  const fileSizeEl = card.querySelector(".file-size");
  if (fileSizeEl && downloadState.progress.total) {
    fileSizeEl.textContent = formatFileSize(downloadState.progress.total);
  }
  return true;
}

/**
 * Setup delegated event listeners for the detected videos list (called once at init).
 */
export function setupDetectedVideosEventDelegation(): void {
  const { detectedVideosList } = dom;
  if (!detectedVideosList) return;

  detectedVideosList.addEventListener("click", async (e) => {
    const target = e.target as HTMLElement;

    // Download button
    const dlBtn = target.closest<HTMLElement>(".video-btn:not(.video-btn-manifest):not(.download-open-btn):not(.download-remove-btn):not(.download-retry-btn)");
    if (dlBtn && !dlBtn.classList.contains("disabled") && !(dlBtn as HTMLButtonElement).disabled) {
      const url = dlBtn.dataset.url;
      if (url) {
        const normalizedUrl = normalizeUrl(url);
        const videoMetadata = detectedVideos[normalizedUrl];
        startDownload(url, videoMetadata, { triggerButton: dlBtn as HTMLButtonElement });
      }
      return;
    }

    // Select Quality button
    const manifestBtn = target.closest<HTMLElement>(".video-btn-manifest");
    if (manifestBtn) {
      const url = manifestBtn.dataset.url;
      if (url) handleSendToManifestTab(url);
      return;
    }

    // REC button
    const recBtn = target.closest<HTMLElement>(".btn-rec");
    if (recBtn && !(recBtn as HTMLButtonElement).disabled) {
      const url = recBtn.dataset.url;
      if (url) {
        const normalizedUrl = normalizeUrl(url);
        const videoMetadata = detectedVideos[normalizedUrl];

        let tabTitle: string | undefined;
        let website: string | undefined;
        try {
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          if (tab) {
            tabTitle = tab.title || undefined;
            if (tab.url) {
              try { website = new URL(tab.url).hostname.replace(/^www\./, ""); } catch {}
            }
          }
        } catch {}

        chrome.runtime.sendMessage({
          type: MessageType.START_RECORDING,
          payload: { url, metadata: videoMetadata, tabTitle, website },
        });
      }
      return;
    }

    // Stop recording button
    const stopRecBtn = target.closest<HTMLElement>(".btn-stop-rec");
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

    // Stop & Save button
    const stopSaveBtn = target.closest<HTMLElement>(".btn-stop-save");
    if (stopSaveBtn) {
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

/**
 * Render detected videos with download status and progress.
 * Uses incremental DOM updates when only progress has changed.
 */
export function renderDetectedVideos(forceFullRebuild = false): void {
  const { detectedVideosList, noVideoBtn } = dom;
  if (!detectedVideosList) return;

  const uniqueVideos = Object.values(detectedVideos);

  if (noVideoBtn) {
    if (uniqueVideos.length === 0) {
      noVideoBtn.classList.add("no-videos-detected");
    } else {
      noVideoBtn.classList.remove("no-videos-detected");
    }
  }

  if (uniqueVideos.length === 0) {
    detectedVideosList.innerHTML = ``;
    renderedVideoCards.clear();
    lastVideoSnapshotJson = "";
    return;
  }

  // Build structure snapshot to detect when full rebuild is needed
  const structureSnapshot = uniqueVideos
    .map((video) => videoStructureKey(video, getDownloadStateForVideo(video)))
    .join("|");
  const structureChanged = structureSnapshot !== lastVideoSnapshotJson;

  // Incremental update: only patch progress elements in existing cards
  if (!structureChanged && !forceFullRebuild) {
    let needsRebuild = false;
    for (const video of uniqueVideos) {
      const normalizedUrl = normalizeUrl(video.url);
      const card = renderedVideoCards.get(normalizedUrl);
      if (card) {
        if (!updateVideoCardProgress(card, video)) {
          needsRebuild = true;
          break;
        }
      }
    }
    if (!needsRebuild) return;
  }

  lastVideoSnapshotJson = structureSnapshot;

  const scrollTop = detectedVideosList.scrollTop;

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

      const hasDrm = video.hasDrm === true;
      if (hasDrm) {
        statusBadge = `<span class="video-status status-drm">DRM Protected</span>`;
        buttonDisabled = true;
      }

      const unsupported = video.unsupported === true;
      if (unsupported && !hasDrm) {
        statusBadge = `<span class="video-status status-unsupported">Unsupported</span>`;
        buttonDisabled = true;
      }

      if (isDownloading) {
        const stage = downloadState.progress.stage;
        statusBadge = `<span class="video-status status-${stage}">${getStatusText(
          stage,
        )}</span>`;

        if (stage === DownloadStage.RECORDING) {
          const segmentsCollected = downloadState.progress.segmentsCollected || 0;
          const downloaded = downloadState.progress.downloaded || 0;
          const downloadedText = formatFileSize(downloaded);

          progressBar = `
            <div class="manifest-progress-container">
              <div class="manifest-progress-bar-wrapper">
                <div class="manifest-progress-bar recording"></div>
              </div>
              <div class="manifest-progress-info">
                <span class="manifest-progress-size">${segmentsCollected} segments &bull; ${downloadedText}</span>
                <span class="rec-badge"><span class="rec-dot"></span>REC</span>
              </div>
            </div>
            <div style="display: flex; gap: 6px; margin-top: 6px;">
              <button class="btn-stop-rec"
                      data-url="${escapeHtml(video.url)}">
                Stop
              </button>
            </div>
          `;
          buttonText = "";
          buttonDisabled = true;
        }

        const isManifestDownload =
          (video.format === "hls" || video.format === "m3u8") &&
          (stage === DownloadStage.DOWNLOADING || stage === DownloadStage.MERGING);

        if (stage === DownloadStage.RECORDING) {
          // already handled above
        } else if (isManifestDownload) {
          const percentage = downloadState.progress.percentage || 0;

          if (stage === DownloadStage.DOWNLOADING) {
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
            <div style="display: flex; gap: 6px; margin-top: 6px;">
              <button class="btn-stop-save" data-url="${escapeHtml(video.url)}">
                Stop &amp; Save
              </button>
            </div>
          `;
          } else if (stage === DownloadStage.MERGING) {
            const message =
              downloadState.progress.message || "Merging streams...";
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

        buttonText = "";
        buttonDisabled = true;
      } else if (isCompleted) {
        statusBadge = `<span class="video-status status-completed">Completed</span>`;
        buttonText = "Redownload";
        buttonDisabled = false;
      } else if (isFailed) {
        statusBadge = `<span class="video-status status-failed">Failed</span>`;
        buttonText = "Retry";
      }

      return `
    <div class="video-item" data-video-url="${escapeHtml(normalizedUrl)}">
      <div class="video-item-preview">
        ${
          video.thumbnail
            ? `
          <img src="${escapeHtml(video.thumbnail)}"
               alt="Video preview"
               loading="lazy">
        `
            : `
          <div class="no-thumbnail">\uD83C\uDFAC</div>
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
              ? `<span style="color: #999; margin-left: 4px;">\u23F1 ${formatDuration(
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
          !isDownloading && !hasDrm && !unsupported
            ? `
          <div style="display: flex; gap: 6px; margin-top: 6px;">
            ${!video.isLive ? `
              <button class="video-btn ${buttonDisabled ? "disabled" : ""}"
                      data-url="${escapeHtml(video.url)}"
                      ${buttonDisabled ? "disabled" : ""}>
                ${buttonText}
              </button>
            ` : ""}
            ${
              (video.format === "hls" || video.format === "m3u8") && !hasDrm && !unsupported
                ? `
              <button class="video-btn-manifest"
                      data-url="${escapeHtml(video.url)}"
                      title="Select quality">
                Select Quality
              </button>
            `
                : ""
            }
            ${video.isLive ? `
              <button class="btn-rec"
                      data-url="${escapeHtml(video.url)}"
                      title="Record live stream">
                REC
              </button>
            ` : ""}
          </div>
        `
            : ""
        }
      </div>
    </div>
  `;
    })
    .join("");

  // Populate card tracking map
  renderedVideoCards.clear();
  detectedVideosList.querySelectorAll<HTMLElement>(".video-item[data-video-url]").forEach((card) => {
    const url = card.dataset.videoUrl;
    if (url) renderedVideoCards.set(url, card);
  });

  // Restore scroll position
  detectedVideosList.scrollTop = scrollTop;

  // Handle thumbnail load errors
  detectedVideosList.querySelectorAll<HTMLImageElement>(".video-item-preview img").forEach((img) => {
    img.addEventListener("load", () => {
      img.style.opacity = "1";
    });
    img.addEventListener("error", () => {
      const video = Object.values(detectedVideos).find((v) => v.thumbnail === img.src);
      if (video) video.thumbnail = undefined;
      img.parentElement!.innerHTML = '<div class="no-thumbnail"></div>';
    });
  });
}
