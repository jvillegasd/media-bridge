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

// SVG play icon for no-thumbnail state
const PLAY_ICON_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>`;

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
    if (fileSizeEl) {
      fileSizeEl.textContent = download.progress.total
        ? formatFileSize(download.progress.total)
        : getStatusText(stage);
    }
    return true;
  }

  return false;
}

function createSectionHeader(label: string, count: number, showClear = false): HTMLElement {
  const section = document.createElement("div");
  section.style.marginBottom = "16px";
  section.dataset.section = label;

  const header = document.createElement("div");
  header.className = "section-header";

  const labelSpan = document.createElement("span");
  labelSpan.textContent = `${label} (${count})`;
  header.appendChild(labelSpan);

  if (showClear) {
    const clearBtn = document.createElement("button");
    clearBtn.className = "section-clear-btn";
    clearBtn.textContent = "Clear all";
    header.appendChild(clearBtn);
  }

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
      img.parentElement!.innerHTML = `<div class="no-thumbnail">${PLAY_ICON_SVG}</div>`;
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

  const title =
    download.metadata.title ||
    getVideoTitleFromUrl(download.metadata.url);
  const stage = download.progress.stage;
  const statusBadge = `<span class="video-status status-${stage}">${getStatusText(stage)}</span>`;

  let progressBar = "";
  const isRecording = stage === DownloadStage.RECORDING;
  const isManifestDownload =
    (download.metadata.format === "hls" ||
      download.metadata.format === "m3u8") &&
    (stage === DownloadStage.DOWNLOADING || stage === DownloadStage.MERGING);

  if (isRecording) {
    const segmentsCollected = download.progress.segmentsCollected || 0;
    const downloaded = download.progress.downloaded || 0;

    progressBar = `
      <div class="manifest-progress-container">
        <div class="manifest-progress-bar-wrapper">
          <div class="manifest-progress-bar recording"></div>
        </div>
        <div class="manifest-progress-info">
          <span class="manifest-progress-size">${segmentsCollected} segments &bull; ${formatFileSize(downloaded)}</span>
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

      progressBar = `
        <div class="manifest-progress-container">
          <div class="manifest-progress-bar-wrapper">
            <div class="manifest-progress-bar" style="width: ${Math.min(percentage, 100)}%"></div>
          </div>
          <div class="manifest-progress-info">
            <span class="manifest-progress-size">${formatFileSize(downloaded)} / ${total > 0 ? formatFileSize(total) : "?"}</span>
            ${speed > 0 ? `<span class="manifest-progress-speed">${formatSpeed(speed)}</span>` : ""}
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
            <span class="manifest-progress-speed">${Math.round(mergingPercentage)}%</span>
          </div>
        </div>
      `;
    }
  } else if (isInProgress) {
    const fileSize = download.progress.total;
    const fileSizeText = fileSize ? formatFileSize(fileSize) : "";

    progressBar = `
      <div class="manifest-progress-container">
        <div class="manifest-progress-bar-wrapper">
          <div class="manifest-progress-bar indeterminate"></div>
        </div>
        <div class="manifest-progress-info">
          <span class="file-size">${fileSizeText || getStatusText(stage)}</span>
          <span class="dl-badge"><span class="dl-dot"></span>DL</span>
        </div>
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
      <div class="card-actions">
        <button class="video-btn download-open-btn" data-download-id="${escapeHtml(download.id)}">Open File</button>
        <button class="video-btn-manifest download-remove-btn" data-download-id="${escapeHtml(download.id)}">Remove</button>
      </div>
    `;
  } else if (isFailed) {
    actionButtons = `
      <div class="card-actions">
        <button class="video-btn download-retry-btn" data-download-id="${escapeHtml(download.id)}">Retry</button>
        <button class="video-btn-manifest download-remove-btn" data-download-id="${escapeHtml(download.id)}">Remove</button>
      </div>
    `;
  } else if (isRecording) {
    actionButtons = `
      <div class="card-actions">
        <button class="btn-stop-rec download-stop-rec-btn" data-url="${escapeHtml(download.url)}">Stop</button>
      </div>
    `;
  } else if (isInProgress) {
    if (!canCancelDownload(download.progress.stage)) {
      actionButtons = `
        <div class="card-actions">
          <button class="video-btn download-remove-btn" data-download-id="${escapeHtml(download.id)}" disabled title="${CANNOT_CANCEL_MESSAGE}" style="opacity: 0.4; cursor: not-allowed;">Cancel</button>
        </div>
      `;
    } else {
      const isDownloading = download.progress.stage === DownloadStage.DOWNLOADING;
      const isManifestType = download.metadata.format === "hls" || download.metadata.format === "m3u8";
      actionButtons = `
        <div class="card-actions">
          ${isDownloading && isManifestType ? `<button class="btn-stop-save" data-action="stop-save" data-url="${escapeHtml(download.metadata.url)}" title="Stop & Save">Stop &amp; Save</button>` : `<button class="video-btn-manifest download-remove-btn" data-download-id="${escapeHtml(download.id)}">Cancel</button>`}
        </div>
      `;
    }
  }

  return `
    <div class="download-item">
      <div class="video-item-preview">
        ${download.metadata.thumbnail
          ? `<img src="${escapeHtml(download.metadata.thumbnail)}" alt="Video preview" loading="lazy">`
          : `<div class="no-thumbnail">${PLAY_ICON_SVG}</div>`
        }
      </div>
      <div class="video-item-content">
        <div class="download-item-header">
          <div class="download-item-title" title="${escapeHtml(download.metadata.url)}">
            ${escapeHtml(title)}
          </div>
          ${statusBadge}
        </div>
        <div class="video-meta">
          ${displayResolution ? `<span class="badge badge-resolution">${escapeHtml(displayResolution)}</span>` : ""}
          ${displayDimensions ? `<span class="badge badge-resolution">${displayDimensions}</span>` : ""}
          <span class="badge badge-link-type">${escapeHtml(getLinkTypeDisplayName(download.metadata.format))}</span>
          <span class="badge badge-format">${escapeHtml(getFormatDisplayName(download.metadata.format, actualFormat))}</span>
          ${download.metadata.duration ? `<span class="badge-duration">${formatDuration(download.metadata.duration)}</span>` : ""}
        </div>
        <div style="font-size: 10px; color: var(--text-tertiary); margin-top: 3px;">
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
        <svg class="empty-state-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
          <polyline points="7 10 12 15 17 10"></polyline>
          <line x1="12" y1="15" x2="12" y2="3"></line>
        </svg>
        <div class="empty-state-title">No downloads yet</div>
        <div class="empty-state-subtitle">Start downloading videos from the Videos tab or load a manifest URL.</div>
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

  const hasTerminal = completed.length > 0 || failed.length > 0;
  const sections: Array<{ label: string; items: DownloadState[]; showClear: boolean }> = [];
  if (inProgress.length > 0) sections.push({ label: "In Progress", items: inProgress, showClear: false });
  if (completed.length > 0) sections.push({ label: "Completed", items: completed, showClear: hasTerminal });
  if (failed.length > 0) sections.push({ label: "Failed", items: failed, showClear: hasTerminal && completed.length === 0 });

  for (const section of sections) {
    const sectionEl = createSectionHeader(section.label, section.items.length, section.showClear);
    for (const download of section.items) {
      const card = createDownloadCardElement(download);
      renderedDownloadCards.set(download.id, card);
      sectionEl.appendChild(card);
    }
    downloadsList.appendChild(sectionEl);
  }

  downloadsList.scrollTop = scrollTop;
}
