/**
 * Popup UI logic with tabs for Detected Videos, Downloads, and Errors
 */

import { DownloadState, VideoMetadata } from '../lib/types';
import { DownloadStateManager } from '../lib/storage/download-state';
import { MessageType } from '../shared/messages';

// DOM elements
const urlInput = document.getElementById('urlInput') as HTMLInputElement;
const downloadBtn = document.getElementById('downloadBtn') as HTMLButtonElement;
const settingsLink = document.getElementById('settingsLink') as HTMLAnchorElement;

// Tab elements
const tabs = document.querySelectorAll('.tab');
const tabContents = {
  detected: document.getElementById('detectedTab') as HTMLDivElement,
  errors: document.getElementById('errorsTab') as HTMLDivElement,
};

// List containers
const detectedVideosList = document.getElementById('detectedVideosList') as HTMLDivElement;
const errorsList = document.getElementById('errorsList') as HTMLDivElement;

// Pagination elements
const errorsPagination = document.getElementById('errorsPagination') as HTMLDivElement;
const errorsPrevBtn = document.getElementById('errorsPrevBtn') as HTMLButtonElement;
const errorsNextBtn = document.getElementById('errorsNextBtn') as HTMLButtonElement;
const errorsPageInfo = document.getElementById('errorsPageInfo') as HTMLSpanElement;
const clearErrorsBtn = document.getElementById('clearErrorsBtn') as HTMLButtonElement;

// Detected videos storage
let detectedVideos: VideoMetadata[] = [];
let downloadStates: DownloadState[] = [];

// Pagination state
const ITEMS_PER_PAGE = 10;
let errorsCurrentPage = 1;

/**
 * Initialize popup
 */
async function init() {
  // Setup tabs
  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      const tabName = tab.getAttribute('data-tab')!;
      switchTab(tabName);
    });
  });

  // Setup event listeners
  downloadBtn.addEventListener('click', handleDownloadClick);
  urlInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
      handleDownloadClick();
    }
  });

  settingsLink.addEventListener('click', (e) => {
    e.preventDefault();
    chrome.runtime.openOptionsPage();
  });

  // Setup pagination button handlers
  errorsPrevBtn.addEventListener('click', () => {
    if (errorsCurrentPage > 1) {
      errorsCurrentPage--;
      loadErrors();
    }
  });

  errorsNextBtn.addEventListener('click', () => {
    errorsCurrentPage++;
    loadErrors();
  });

  clearErrorsBtn.addEventListener('click', handleClearErrors);

  // Listen for messages
  chrome.runtime.onMessage.addListener((message) => {
    if (message.type === MessageType.DOWNLOAD_PROGRESS) {
      loadDownloadStates();
      renderDetectedVideos();
      loadErrors();
    }
    if (message.type === MessageType.VIDEO_DETECTED) {
      addDetectedVideo(message.payload);
    }
    if (message.type === MessageType.DOWNLOAD_FAILED) {
      loadDownloadStates();
      renderDetectedVideos();
      loadErrors();
      // Show error notification if it's a user-initiated download
      if (message.payload && message.payload.error) {
        // Error will be shown in the error tab, but we can also show a brief notification
        console.warn('Download failed:', message.payload.error);
      }
    }
  });

  // Load data
  await loadDetectedVideos();
  await loadDownloadStates();
  await loadErrors();

  // Get detected videos from current tab
  await requestDetectedVideos();

  // Refresh data periodically
  setInterval(async () => {
    await loadDownloadStates();
    renderDetectedVideos();
    await loadErrors();
    await requestDetectedVideos();
  }, 2000);
}

/**
 * Switch between tabs
 */
function switchTab(tabName: string) {
  tabs.forEach(tab => {
    if (tab.getAttribute('data-tab') === tabName) {
      tab.classList.add('active');
    } else {
      tab.classList.remove('active');
    }
  });

  Object.keys(tabContents).forEach(key => {
    if (key === tabName) {
      tabContents[key as keyof typeof tabContents].classList.add('active');
    } else {
      tabContents[key as keyof typeof tabContents].classList.remove('active');
    }
  });

  // Reset pagination when switching tabs
  if (tabName === 'errors') {
    errorsCurrentPage = 1;
  }
}

/**
 * Request detected videos from current tab
 */
async function requestDetectedVideos() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab.id) {
      const response = await chrome.tabs.sendMessage(tab.id, {
        type: MessageType.GET_DETECTED_VIDEOS,
      });
      
      // Merge received videos with existing ones
      if (response && response.videos && Array.isArray(response.videos)) {
        // Clear existing videos from this tab and merge
        const currentUrl = tab.url || '';
        detectedVideos = detectedVideos.filter(v => !v.pageUrl || !v.pageUrl.includes(currentUrl));
        
        // Add all videos from content script
        response.videos.forEach((video: VideoMetadata) => {
          if (!detectedVideos.find(v => v.url === video.url)) {
            detectedVideos.push(video);
          }
        });
        
        renderDetectedVideos();
      }
    }
  } catch (error) {
    // Tab might not have content script, ignore
    console.debug('Could not get detected videos:', error);
  }
}

/**
 * Add detected video
 */
function addDetectedVideo(video: VideoMetadata) {
  // Check if video already exists
  if (!detectedVideos.find(v => v.url === video.url)) {
    detectedVideos.push(video);
    renderDetectedVideos();
  }
}

/**
 * Load detected videos
 */
async function loadDetectedVideos() {
  // Get from storage or use in-memory
  renderDetectedVideos();
}

/**
 * Load download states
 */
async function loadDownloadStates() {
  downloadStates = await DownloadStateManager.getAllDownloads();
}

/**
 * Get download state for a video URL
 */
function getDownloadStateForVideo(url: string): DownloadState | undefined {
  return downloadStates.find(d => {
    // Normalize URLs for comparison (remove hash fragments)
    const normalizedVideoUrl = url.split('#')[0];
    const normalizedDownloadUrl = d.url.split('#')[0];
    return normalizedVideoUrl === normalizedDownloadUrl;
  });
}

/**
 * Render detected videos with download status
 */
function renderDetectedVideos() {
  if (detectedVideos.length === 0) {
    detectedVideosList.innerHTML = `
      <div class="empty-state">
        No videos detected on this page.<br>
        Use the input above to paste a video URL manually.
      </div>
    `;
    return;
  }

  detectedVideosList.innerHTML = detectedVideos.map(video => {
    const downloadState = getDownloadStateForVideo(video.url);
    const isDownloading = downloadState && downloadState.progress.stage !== 'completed' && downloadState.progress.stage !== 'failed';
    const isCompleted = downloadState && downloadState.progress.stage === 'completed';
    const isFailed = downloadState && downloadState.progress.stage === 'failed';
    
    let statusBadge = '';
    let progressBar = '';
    let speedInfo = '';
    let buttonText = 'Download';
    let buttonDisabled = false;
    
    if (isDownloading) {
      const stage = downloadState.progress.stage;
      statusBadge = `<span class="video-status status-${stage}">${getStatusText(stage)}</span>`;
      
      if (downloadState.progress.percentage !== undefined) {
        progressBar = `
          <div class="progress-bar">
            <div class="progress-fill" style="width: ${downloadState.progress.percentage}%"></div>
          </div>
        `;
      }
      
      if (downloadState.progress.speed) {
        speedInfo = `<div class="download-speed">${formatSpeed(downloadState.progress.speed)}</div>`;
      }
      
      buttonText = getStatusText(stage);
      buttonDisabled = true;
    } else if (isCompleted) {
      statusBadge = `<span class="video-status status-completed">Completed</span>`;
      buttonText = 'Downloaded';
      buttonDisabled = true;
    } else if (isFailed) {
      statusBadge = `<span class="video-status status-failed">Failed</span>`;
      buttonText = 'Retry';
    }
    
    return `
    <div class="video-item">
      <div class="video-item-preview">
        ${video.thumbnail ? `
          <img src="${escapeHtml(video.thumbnail)}" 
               alt="Video preview" 
               onerror="this.parentElement.innerHTML='<div class=\\'no-thumbnail\\'>🎬</div>'"
               loading="lazy">
        ` : `
          <div class="no-thumbnail">🎬</div>
        `}
      </div>
      <div class="video-item-content">
        <div class="video-item-header">
          <div class="video-item-title" title="${escapeHtml(video.url)}">
            ${escapeHtml(video.title || getVideoTitleFromUrl(video.url))}
          </div>
          ${statusBadge}
        </div>
        <div class="video-meta">
          ${video.resolution ? `<span class="video-resolution">${escapeHtml(video.resolution)}</span>` : ''}
          ${video.width && video.height && !video.resolution ? `<span class="video-resolution">${video.width}x${video.height}</span>` : ''}
          <span class="video-format">${escapeHtml(video.format.toUpperCase())}</span>
          ${video.duration ? `<span style="color: #666; margin-left: 4px;">⏱ ${formatDuration(video.duration)}</span>` : ''}
        </div>
        ${video.pageUrl ? `
          <div style="font-size: 11px; color: #999; margin-top: 4px;">
            From: ${escapeHtml(new URL(video.pageUrl).hostname)}
          </div>
        ` : ''}
        ${progressBar}
        ${speedInfo}
        ${downloadState && downloadState.progress.message ? `
          <div style="font-size: 11px; color: #666; margin-top: 4px;">
            ${escapeHtml(downloadState.progress.message)}
          </div>
        ` : ''}
        ${isFailed && downloadState.progress.error ? `
          <div style="font-size: 11px; color: #d32f2f; margin-top: 4px;">
            ${escapeHtml(downloadState.progress.error)}
          </div>
        ` : ''}
        <button class="video-btn ${buttonDisabled ? 'disabled' : ''}" 
                data-url="${escapeHtml(video.url)}" 
                ${buttonDisabled ? 'disabled' : ''}>
          ${buttonText}
        </button>
      </div>
    </div>
  `;
  }).join('');

  // Add click handlers for download buttons
  detectedVideosList.querySelectorAll('.video-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const button = e.target as HTMLButtonElement;
      if (button.disabled) return;
      const url = button.getAttribute('data-url')!;
      startDownload(url);
    });
  });
}


/**
 * Handle clear errors button click
 */
async function handleClearErrors() {
  const downloads = await DownloadStateManager.getAllDownloads();
  const failedDownloads = downloads.filter(d => d.progress.stage === 'failed');
  
  if (failedDownloads.length === 0) {
    return; // No errors to clear
  }

  // Show confirmation dialog
  const confirmed = confirm(
    `Are you sure you want to clear ${failedDownloads.length} error${failedDownloads.length > 1 ? 's' : ''}?\n\nThis action cannot be undone.`
  );

  if (!confirmed) {
    return;
  }

  // Clear all failed downloads
  clearErrorsBtn.disabled = true;
  clearErrorsBtn.textContent = 'Clearing...';
  
  try {
    // Remove all failed downloads
    for (const download of failedDownloads) {
      await DownloadStateManager.removeDownload(download.id);
    }
    
    // Reload errors list
    errorsCurrentPage = 1;
    await loadErrors();
  } catch (error) {
    console.error('Failed to clear errors:', error);
    alert('Failed to clear errors. Please try again.');
  } finally {
    clearErrorsBtn.disabled = false;
    clearErrorsBtn.innerHTML = `
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <polyline points="3 6 5 6 21 6"></polyline>
        <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
      </svg>
      Clear Errors
    `;
  }
}

/**
 * Load and display errors
 */
async function loadErrors() {
  const downloads = await DownloadStateManager.getAllDownloads();
  const failedDownloads = downloads.filter(d => d.progress.stage === 'failed');
  
  // Sort by updated date (newest first), fallback to createdAt
  failedDownloads.sort((a, b) => {
    const aTime = a.updatedAt || a.createdAt || 0;
    const bTime = b.updatedAt || b.createdAt || 0;
    return bTime - aTime; // Descending order
  });
  
  // Enable/disable clear button based on errors count
  clearErrorsBtn.disabled = failedDownloads.length === 0;
  
  if (failedDownloads.length === 0) {
    errorsList.innerHTML = '<div class="empty-state">No errors</div>';
    errorsPagination.style.display = 'none';
    return;
  }

  // Calculate pagination
  const totalPages = Math.ceil(failedDownloads.length / ITEMS_PER_PAGE);
  if (errorsCurrentPage > totalPages) {
    errorsCurrentPage = totalPages || 1;
  }
  
  const startIndex = (errorsCurrentPage - 1) * ITEMS_PER_PAGE;
  const endIndex = startIndex + ITEMS_PER_PAGE;
  const paginatedErrors = failedDownloads.slice(startIndex, endIndex);

  // Render errors
  if (paginatedErrors.length === 0) {
    errorsList.innerHTML = '<div class="empty-state">No errors on this page</div>';
  } else {
    errorsList.innerHTML = paginatedErrors.map(download => {
      const errorText = download.progress.error || 'Unknown error';
      const timestamp = download.updatedAt || download.createdAt || Date.now();
      const dateTime = formatDateTime(timestamp);
      
      return `
      <div class="error-item">
        <div class="error-item-header">
          <div class="error-item-title" title="${escapeHtml(download.url)}">
            ${escapeHtml(getDownloadTitle(download))}
          </div>
          <span class="error-item-status status-failed">Failed</span>
        </div>
        <div class="error-item-meta">
          <span class="error-item-datetime">${dateTime}</span>
          <button class="error-copy-btn" 
                  data-error="${escapeHtml(errorText)}" 
                  data-url="${escapeHtml(download.url)}"
                  data-title="${escapeHtml(getDownloadTitle(download))}"
                  data-timestamp="${timestamp}"
                  title="Copy error traceback">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
            </svg>
          </button>
        </div>
        ${errorText ? `
          <div class="error-item-message">
            ${escapeHtml(errorText)}
          </div>
        ` : ''}
        <div class="error-item-url" data-url="${escapeHtml(download.url)}">
          ${escapeHtml(download.url)}
        </div>
      </div>
    `;
    }).join('');

    // Add click handlers to open failed video URLs
    errorsList.querySelectorAll('.error-item-url').forEach(link => {
      link.addEventListener('click', async () => {
        const url = (link as HTMLElement).getAttribute('data-url')!;
        await chrome.tabs.create({ url });
      });
    });

    // Add click handlers for copy buttons
    errorsList.querySelectorAll('.error-copy-btn').forEach(btnElement => {
      const btn = btnElement as HTMLButtonElement;
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const errorText = btn.getAttribute('data-error') || '';
        const url = btn.getAttribute('data-url') || '';
        const title = btn.getAttribute('data-title') || '';
        const timestampStr = btn.getAttribute('data-timestamp') || '';
        const timestamp = timestampStr ? parseInt(timestampStr) : Date.now();
        
        // Build full error traceback
        const fullError = `Error: ${errorText}\n\nURL: ${url}\nTimestamp: ${formatDateTime(timestamp)}\nTitle: ${title}`;
        
        try {
          await navigator.clipboard.writeText(fullError);
          // Visual feedback
          const originalHTML = btn.innerHTML;
          btn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>';
          btn.style.color = '#4caf50';
          setTimeout(() => {
            btn.innerHTML = originalHTML;
            btn.style.color = '';
          }, 2000);
        } catch (err) {
          // Fallback for older browsers
          const textArea = document.createElement('textarea');
          textArea.value = fullError;
          textArea.style.position = 'fixed';
          textArea.style.opacity = '0';
          document.body.appendChild(textArea);
          textArea.select();
          try {
            document.execCommand('copy');
            const originalHTML = btn.innerHTML;
            btn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>';
            btn.style.color = '#4caf50';
            setTimeout(() => {
              btn.innerHTML = originalHTML;
              btn.style.color = '';
            }, 2000);
          } catch (fallbackErr) {
            console.error('Failed to copy:', fallbackErr);
          }
          document.body.removeChild(textArea);
        }
      });
    });
  }

  // Update pagination controls
  if (totalPages > 1) {
    errorsPagination.style.display = 'flex';
    errorsPageInfo.textContent = `Page ${errorsCurrentPage} of ${totalPages} (${failedDownloads.length} total)`;
    errorsPrevBtn.disabled = errorsCurrentPage === 1;
    errorsNextBtn.disabled = errorsCurrentPage === totalPages;
  } else {
    errorsPagination.style.display = 'none';
  }
}

/**
 * Handle download button click
 */
async function handleDownloadClick() {
  const url = urlInput.value.trim();
  
  if (!url) {
    alert('Please enter a video URL');
    return;
  }

  try {
    new URL(url);
  } catch {
    alert('Invalid URL');
    return;
  }

  await startDownload(url);
  urlInput.value = '';
}

/**
 * Start download
 */
async function startDownload(url: string) {
  downloadBtn.disabled = true;
  downloadBtn.textContent = 'Starting...';

  try {
    const response = await chrome.runtime.sendMessage({
      type: MessageType.DOWNLOAD_REQUEST,
      payload: {
        url,
      },
    });

    if (response && response.success) {
      await loadDownloadStates();
      renderDetectedVideos();
    } else {
      alert(response?.error || 'Download failed');
    }
  } catch (error) {
    console.error('Download request failed:', error);
    alert('Failed to start download');
  } finally {
    downloadBtn.disabled = false;
    downloadBtn.textContent = 'Download';
  }
}

/**
 * Get download title
 */
function getDownloadTitle(download: DownloadState): string {
  if (download.metadata?.title) {
    return download.metadata.title;
  }
  
  try {
    const url = new URL(download.url);
    const pathname = url.pathname;
    const filename = pathname.split('/').pop();
    return filename || download.url.substring(0, 50) + '...';
  } catch {
    return download.url.substring(0, 50) + '...';
  }
}

/**
 * Get video title from URL
 */
function getVideoTitleFromUrl(url: string): string {
  try {
    const urlObj = new URL(url);
    const pathname = urlObj.pathname;
    const filename = pathname.split('/').pop();
    return filename || url.substring(0, 50) + '...';
  } catch {
    return url.substring(0, 50) + '...';
  }
}

/**
 * Get status text
 */
function getStatusText(stage: string): string {
  const statusMap: Record<string, string> = {
    detecting: 'Detecting',
    downloading: 'Downloading',
    merging: 'Merging',
    saving: 'Saving',
    uploading: 'Uploading',
    completed: 'Completed',
    failed: 'Failed',
  };
  
  return statusMap[stage] || stage;
}

/**
 * Format duration in seconds to readable format
 */
function formatDuration(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  
  if (hours > 0) {
    return `${hours}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  }
  return `${minutes}:${secs.toString().padStart(2, '0')}`;
}

/**
 * Format speed in bytes per second to readable format
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
 * Format timestamp to readable datetime
 */
function formatDateTime(timestamp: number): string {
  const date = new Date(timestamp);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  // Show relative time for recent errors
  if (diffMins < 1) {
    return 'Just now';
  } else if (diffMins < 60) {
    return `${diffMins}m ago`;
  } else if (diffHours < 24) {
    return `${diffHours}h ago`;
  } else if (diffDays < 7) {
    return `${diffDays}d ago`;
  }

  // Show full date for older errors
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  
  const isToday = date.toDateString() === now.toDateString();
  if (isToday) {
    return `Today ${hours}:${minutes}`;
  }
  
  const isThisYear = year === now.getFullYear();
  if (isThisYear) {
    return `${month}/${day} ${hours}:${minutes}`;
  }
  
  return `${year}-${month}-${day} ${hours}:${minutes}`;
}

/**
 * Escape HTML
 */
function escapeHtml(text: string): string {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// Initialize when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
