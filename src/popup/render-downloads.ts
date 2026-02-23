/**
 * Downloads tab rendering with incremental DOM updates.
 */

import { DownloadState, DownloadStage } from "../core/types";
import { storeDownload } from "../core/database/downloads";
import { dom, downloadStates } from "./state";
import {
  escapeHtml,
  formatDuration,
  formatFileSize,
  formatSpeed,
  getActualFileFormat,
  getFormatDisplayName,
  getLinkTypeDisplayName,
  getStatusText,
  getVideoTitleFromUrl,
} from "./utils";
import { canCancelDownload, CANNOT_CANCEL_MESSAGE } from "../core/utils/download-utils";

// Incremental rendering state
const renderedDownloadCards = new Map<string, HTMLElement>();
let lastDownloadSnapshotJson = "";

/**
 * Build a snapshot key for a download to detect structural changes.
 */
function downloadStructureKey(d: DownloadState): string {
  return `${d.id}:${d.progress.stage}:${d.metadata.thumbnail ?? ""}:${d.localPath ?? ""}`;
}

/**
 * Update only the progress-related elements inside an existing download card.
 */
function updateDownloadCardProgress(card: HTMLElement, download: DownloadState): boolean {
  const stage = download.progress.stage;
  if (
    stage === DownloadStage.COMPLETED ||
    stage === DownloadStage.FAILED ||
    stage === DownloadStage.CANCELLED
  ) {
    return true;
  }

  const isRecording = stage === DownloadStage.RECORDING;
  const isManifestDownload =
    (download.metadata.format === "hls" || download.metadata.format === "m3u8") &&
    (stage === DownloadStage.DOWNLOADING || stage === DownloadStage.MERGING);

  if (isRecording) {
    const sizeEl = card.querySelector(".manifest-progress-size");
    if (!sizeEl) return false;
    const segmentsCollected = download.progress.segmentsCollected || 0;
    const downloaded = download.progress.downloaded || 0;
    sizeEl.textContent = `${segmentsCollected} segments \u2022 ${formatFileSize(downloaded)}`;
    return true;
  }

  if (isManifestDownload && stage === DownloadStage.DOWNLOADING) {
    const bar = card.querySelector<HTMLElement>(".manifest-progress-bar");
    const sizeEl = card.querySelector(".manifest-progress-size");
    const speedEl = card.querySelector(".manifest-progress-speed");
    if (!bar || !sizeEl) return false;

    const percentage = download.progress.percentage || 0;
    const downloaded = download.progress.downloaded || 0;
    const total = download.progress.total || 0;
    const speed = download.progress.speed || 0;

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

    const percentage = Math.min(Math.max(download.progress.percentage || 0, 0), 100);
    const message = download.progress.message || "Merging streams...";

    bar.style.width = `${percentage}%`;
    sizeEl.textContent = message;
    if (speedEl) speedEl.textContent = `${Math.round(percentage)}%`;
    return true;
  }

  if (stage === DownloadStage.DOWNLOADING || stage === DownloadStage.DETECTING || stage === DownloadStage.SAVING) {
    const fileSizeEl = card.querySelector(".file-size");
    if (fileSizeEl && download.progress.total) {
      fileSizeEl.textContent = formatFileSize(download.progress.total);
      return true;
    }
    return true;
  }

  return false;
}

function createSectionHeader(label: string, count: number): HTMLElement {
  const section = document.createElement("div");
  section.style.marginBottom = "16px";
  section.dataset.section = label;

  const header = document.createElement("div");
  header.style.cssText = "font-size: 12px; font-weight: 600; color: var(--text-secondary); margin-bottom: 8px; text-transform: uppercase; letter-spacing: 0.5px;";
  header.textContent = `${label} (${count})`;
  header.className = "section-header";
  section.appendChild(header);
  return section;
}

function createDownloadCardElement(download: DownloadState): HTMLElement {
  const wrapper = document.createElement("div");
  wrapper.innerHTML = renderDownloadItem(download);
  const card = wrapper.firstElementChild as HTMLElement;
  card.dataset.downloadId = download.id;

  const img = card.querySelector<HTMLImageElement>(".video-item-preview img");
  if (img) {
    img.addEventListener("load", () => { img.style.opacity = "1"; });
    img.addEventListener("error", () => {
      const dl = downloadStates.find((d) => d.metadata.thumbnail === img.src);
      if (dl) {
        dl.metadata.thumbnail = undefined;
        storeDownload(dl);
      }
      img.parentElement!.innerHTML = '<div class="no-thumbnail"></div>';
    });
  }

  return card;
}

/**
 * Render a single download item to HTML string.
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
  const isRecording = stage === DownloadStage.RECORDING;
  const isManifestDownload =
    (download.metadata.format === "hls" ||
      download.metadata.format === "m3u8") &&
    (stage === DownloadStage.DOWNLOADING || stage === DownloadStage.MERGING);

  if (isRecording) {
    const segmentsCollected = download.progress.segmentsCollected || 0;
    const downloaded = download.progress.downloaded || 0;
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
    `;
  } else if (isInProgress && isManifestDownload) {
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

  const date = new Date(download.updatedAt);
  const dateText = date.toLocaleDateString() + " " + date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  let actionButtons = "";
  if (isCompleted && download.localPath) {
    actionButtons = `
      <div style="display: flex; gap: 6px; margin-top: 6px;">
        <button class="video-btn download-open-btn" data-download-id="${escapeHtml(download.id)}">
          Open File
        </button>
        <button class="video-btn download-remove-btn" data-download-id="${escapeHtml(download.id)}">
          Remove
        </button>
      </div>
    `;
  } else if (isFailed) {
    actionButtons = `
      <div style="display: flex; gap: 6px; margin-top: 6px;">
        <button class="video-btn download-retry-btn" data-download-id="${escapeHtml(download.id)}">
          Retry
        </button>
        <button class="video-btn download-remove-btn" data-download-id="${escapeHtml(download.id)}">
          Remove
        </button>
      </div>
    `;
  } else if (isRecording) {
    actionButtons = `
      <div style="display: flex; gap: 6px; margin-top: 6px;">
        <button class="btn-stop-rec download-stop-rec-btn"
                data-url="${escapeHtml(download.url)}">
          Stop
        </button>
      </div>
    `;
  } else if (isInProgress) {
    if (!canCancelDownload(download.progress.stage)) {
      actionButtons = `
        <div style="display: flex; gap: 6px; margin-top: 6px;">
          <button class="video-btn download-remove-btn" data-download-id="${escapeHtml(download.id)}" disabled title="${CANNOT_CANCEL_MESSAGE}" style="opacity: 0.6; cursor: not-allowed;">
            Cancel
          </button>
        </div>
        <div style="font-size: 11px; color: #888; margin-top: 4px;">
          Cannot cancel: Chunks downloaded, merging in progress
        </div>
      `;
    } else {
      const isDownloading = download.progress.stage === DownloadStage.DOWNLOADING;
      const isManifestType = download.metadata.format === "hls" || download.metadata.format === "m3u8";
      actionButtons = `
        <div style="display: flex; gap: 6px; margin-top: 6px;">
          ${isDownloading && isManifestType ? `<button class="btn-stop-save" data-action="stop-save" data-url="${escapeHtml(download.metadata.url)}" title="Stop & Save">
            Stop &amp; Save
          </button>` : `<button class="video-btn download-remove-btn" data-download-id="${escapeHtml(download.id)}">
            Cancel
          </button>`}
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
               loading="lazy">
        `
            : `
          <div class="no-thumbnail">\uD83C\uDFAC</div>
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
              ? `<span style="color: #999; margin-left: 4px;">\u23F1 ${formatDuration(
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
 * Render downloads list with incremental DOM updates.
 */
export function renderDownloads(forceFullRebuild = false): void {
  const { downloadsList } = dom;
  if (!downloadsList) return;

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

  if (inProgress.length === 0 && completed.length === 0 && failed.length === 0) {
    downloadsList.innerHTML = `
      <div class="empty-state">
        No downloads yet.<br>
        Start downloading videos from the Videos tab.
      </div>
    `;
    renderedDownloadCards.clear();
    lastDownloadSnapshotJson = "";
    return;
  }

  const structureSnapshot = downloadStates.map(downloadStructureKey).join("|");
  const structureChanged = structureSnapshot !== lastDownloadSnapshotJson;

  if (!structureChanged && !forceFullRebuild) {
    let needsRebuild = false;
    for (const download of downloadStates) {
      const card = renderedDownloadCards.get(download.id);
      if (card) {
        if (!updateDownloadCardProgress(card, download)) {
          needsRebuild = true;
          break;
        }
      }
    }
    if (!needsRebuild) return;
  }

  lastDownloadSnapshotJson = structureSnapshot;

  const scrollTop = downloadsList.scrollTop;
  downloadsList.innerHTML = "";
  renderedDownloadCards.clear();

  const sections: Array<{ label: string; items: DownloadState[] }> = [];
  if (inProgress.length > 0) sections.push({ label: "In Progress", items: inProgress });
  if (completed.length > 0) sections.push({ label: "Completed", items: completed });
  if (failed.length > 0) sections.push({ label: "Failed", items: failed });

  for (const section of sections) {
    const sectionEl = createSectionHeader(section.label, section.items.length);
    for (const download of section.items) {
      const card = createDownloadCardElement(download);
      renderedDownloadCards.set(download.id, card);
      sectionEl.appendChild(card);
    }
    downloadsList.appendChild(sectionEl);
  }

  downloadsList.scrollTop = scrollTop;
}
