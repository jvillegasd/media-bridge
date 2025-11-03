/**
 * Popup UI logic
 */

import { DownloadState } from '../lib/types';
import { DownloadStateManager } from '../lib/storage/download-state';
import { MessageType } from '../shared/messages';

// DOM elements
const urlInput = document.getElementById('urlInput') as HTMLInputElement;
const downloadBtn = document.getElementById('downloadBtn') as HTMLButtonElement;
const downloadsList = document.getElementById('downloadsList') as HTMLDivElement;
const settingsLink = document.getElementById('settingsLink') as HTMLAnchorElement;

/**
 * Initialize popup
 */
async function init() {
  // Load current downloads
  await loadDownloads();

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

  // Listen for download updates
  chrome.runtime.onMessage.addListener((message) => {
    if (message.type === MessageType.DOWNLOAD_PROGRESS) {
      loadDownloads();
    }
  });

  // Refresh downloads every 2 seconds
  setInterval(loadDownloads, 2000);
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

  // Validate URL
  try {
    new URL(url);
  } catch {
    alert('Invalid URL');
    return;
  }

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
      urlInput.value = '';
      await loadDownloads();
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
 * Load and display downloads
 */
async function loadDownloads() {
  const downloads = await DownloadStateManager.getAllDownloads();
  
  if (downloads.length === 0) {
    downloadsList.innerHTML = '<div class="empty-state">No downloads yet</div>';
    return;
  }

  // Sort by creation date (newest first)
  downloads.sort((a, b) => b.createdAt - a.createdAt);

  downloadsList.innerHTML = downloads.map(download => `
    <div class="download-item">
      <div class="download-item-header">
        <div class="download-item-title" title="${escapeHtml(download.url)}">
          ${escapeHtml(getDownloadTitle(download))}
        </div>
        <span class="download-item-status status-${download.progress.stage}">
          ${getStatusText(download.progress.stage)}
        </span>
      </div>
      ${download.progress.percentage !== undefined ? `
        <div class="progress-bar">
          <div class="progress-fill" style="width: ${download.progress.percentage}%"></div>
        </div>
      ` : ''}
      ${download.progress.message ? `
        <div style="font-size: 12px; color: #666; margin-top: 4px;">
          ${escapeHtml(download.progress.message)}
        </div>
      ` : ''}
      ${download.progress.error ? `
        <div style="font-size: 12px; color: #d32f2f; margin-top: 4px;">
          Error: ${escapeHtml(download.progress.error)}
        </div>
      ` : ''}
    </div>
  `).join('');
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
 * Get status text
 */
function getStatusText(stage: string): string {
  const statusMap: Record<string, string> = {
    detecting: 'Detecting',
    downloading: 'Downloading',
    merging: 'Merging',
    uploading: 'Uploading',
    saving: 'Saving',
    completed: 'Completed',
    failed: 'Failed',
  };
  
  return statusMap[stage] || stage;
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

