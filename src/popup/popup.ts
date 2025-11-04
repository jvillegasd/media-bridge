/**
 * Popup UI logic with tabs for Detected Videos, Downloads, and Errors
 */

import { DownloadState, VideoMetadata, VideoFormat } from '../core/types';
import { DownloadStateManager } from '../core/storage/download-state';
import { MessageType } from '../shared/messages';
import { normalizeUrl } from '../core/utils/url-utils';
import { v4 as uuidv4 } from 'uuid';


// DOM elements
let noVideoBtn: HTMLButtonElement | null = null;
let forceDetectionBtn: HTMLButtonElement | null = null;
let closeNoVideoNoticeBtn: HTMLButtonElement | null = null;
let noVideoNotice: HTMLDivElement | null = null;
let settingsBtn: HTMLButtonElement | null = null;
let downloadsBtn: HTMLButtonElement | null = null;

// List containers
const detectedVideosList = document.getElementById('detectedVideosList') as HTMLDivElement;

// Detected videos storage
let detectedVideos: VideoMetadata[] = [];
let downloadStates: DownloadState[] = [];

// Quality selection removed - only direct downloads supported

/**
 * Initialize popup
 */
async function init() {
  // Initialize DOM elements
  noVideoBtn = document.getElementById('noVideoBtn') as HTMLButtonElement;
  forceDetectionBtn = document.getElementById('forceDetectionBtn') as HTMLButtonElement;
  closeNoVideoNoticeBtn = document.getElementById('closeNoVideoNotice') as HTMLButtonElement;
  noVideoNotice = document.getElementById('noVideoNotice') as HTMLDivElement;
  settingsBtn = document.getElementById('settingsBtn') as HTMLButtonElement;
  downloadsBtn = document.getElementById('downloadsBtn') as HTMLButtonElement;

  // Ensure notice is hidden initially
  if (noVideoNotice) {
    noVideoNotice.classList.remove('show');
    noVideoNotice.classList.remove('visible');
  }

  // Setup event listeners
  if (noVideoBtn) {
    noVideoBtn.addEventListener('click', toggleNoVideoNotice);
  }
  if (closeNoVideoNoticeBtn) {
    closeNoVideoNoticeBtn.addEventListener('click', hideNoVideoNotice);
  }
  if (forceDetectionBtn) {
    forceDetectionBtn.addEventListener('click', handleForceDetection);
  }
  if (settingsBtn) {
    settingsBtn.addEventListener('click', () => {
      chrome.runtime.openOptionsPage();
    });
  }
  if (downloadsBtn) {
    downloadsBtn.addEventListener('click', handleOpenDownloads);
  }

  // Listen for messages
  chrome.runtime.onMessage.addListener((message) => {
    // Check if extension context is still valid
    if (chrome.runtime.lastError && chrome.runtime.lastError.message) {
      if (chrome.runtime.lastError.message.includes('Extension context invalidated')) {
        console.debug('Extension context invalidated, reloading popup may be needed');
        return;
      }
    }
    
    try {
      if (message.type === MessageType.DOWNLOAD_PROGRESS) {
        loadDownloadStates();
        renderDetectedVideos();
      }
      if (message.type === MessageType.VIDEO_DETECTED) {
        addDetectedVideo(message.payload);
      }
      if (message.type === MessageType.DOWNLOAD_FAILED) {
        loadDownloadStates();
        renderDetectedVideos();
        // Log error for debugging
        if (message.payload && message.payload.error) {
          console.warn('Download failed:', message.payload.error);
        }
      }
    } catch (error) {
      console.debug('Error handling message:', error);
    }
  });

  // Load data
  await loadDetectedVideos();
  await loadDownloadStates();

  // Get detected videos from current tab
  await requestDetectedVideos();

  // Refresh data periodically
  setInterval(async () => {
    await loadDownloadStates();
    renderDetectedVideos();
    await requestDetectedVideos();
  }, 2000);
}

// Tab switching removed - only video cards shown

function showNoVideoNotice() {
  if (!noVideoNotice) return;
  noVideoNotice.classList.add('show');
  noVideoNotice.classList.remove('visible'); // Remove old class if exists
  // Force inline style as backup
  noVideoNotice.style.display = 'block';
}

function hideNoVideoNotice() {
  if (!noVideoNotice) return;
  noVideoNotice.classList.remove('show');
  noVideoNotice.classList.remove('visible'); // Remove old class if exists
  // Force inline style as backup
  noVideoNotice.style.display = 'none';
}

function toggleNoVideoNotice() {
  // Only show the notice, don't toggle - X button is used to close
  showNoVideoNotice();
}

async function handleForceDetection() {
  if (!forceDetectionBtn) return;
  const originalText = forceDetectionBtn.textContent;
  forceDetectionBtn.disabled = true;
  forceDetectionBtn.textContent = 'Refreshing...';

  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const activeTab = tabs[0];

    if (!activeTab || activeTab.id === undefined) {
      throw new Error('Active tab not found');
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
    console.error('Failed to refresh tab for force detection:', error);
    alert('Failed to refresh the page. Please try again.');
  } finally {
    forceDetectionBtn.disabled = false;
    forceDetectionBtn.textContent = originalText || 'Force detection';
  }
}

async function handleOpenDownloads() {
  if (!downloadsBtn) return;
  
  try {
    // Open the default downloads folder
    await chrome.downloads.showDefaultFolder();
  } catch (error) {
    console.error('Failed to open downloads folder:', error);
    alert('Failed to open downloads folder. Please check your browser settings.');
  }
}

/**
 * Request detected videos from current tab
 */
async function requestDetectedVideos() {
  try {
    // Check if runtime is available
    if (!chrome?.runtime || !chrome?.tabs) {
      console.debug('Chrome runtime or tabs API not available');
      return;
    }
    
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab.id) {
      let response;
      try {
        response = await new Promise<any>((resolve, reject) => {
          chrome.tabs.sendMessage(tab.id!, {
            type: MessageType.GET_DETECTED_VIDEOS,
          }, (response) => {
            // Check for extension context invalidation after API call
            if (chrome.runtime.lastError) {
              const errorMessage = chrome.runtime.lastError.message || '';
              if (errorMessage.includes('Extension context invalidated')) {
                console.debug('Extension context invalidated, cannot communicate with content script');
                reject(new Error('Extension context invalidated'));
                return;
              }
              // Other errors (content script not available, etc.) - ignore silently
              reject(new Error(chrome.runtime.lastError.message || 'Unknown error'));
              return;
            }
            resolve(response);
          });
        });
      } catch (error: any) {
        // Handle extension context invalidated or content script not available
        if (error?.message?.includes('Extension context invalidated')) {
          console.debug('Extension context invalidated, cannot communicate with content script');
          return;
        }
        // Content script might not be available, ignore
        console.debug('Could not send message to content script:', error);
        return;
      }
      
      // Merge received videos with existing ones
      if (response && response.videos && Array.isArray(response.videos)) {
        // Clear existing videos from this tab and merge
        const currentUrl = tab.url || '';
        detectedVideos = detectedVideos.filter(v => !v.pageUrl || !v.pageUrl.includes(currentUrl));
        
        // Add all videos from content script with improved deduplication
        response.videos.forEach((video: VideoMetadata) => {
          getOrCreateVideoId(video);

          // Use normalized URLs for comparison to prevent duplicates
          const normalizedVideoUrl = normalizeUrl(video.url);
          const existingIndex = detectedVideos.findIndex(v => normalizeUrl(v.url) === normalizedVideoUrl);
          
          if (existingIndex < 0) {
            detectedVideos.push(video);
          } else {
            // Update existing entry with latest metadata if needed
            const existing = detectedVideos[existingIndex];
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
    console.debug('Could not get detected videos:', error);
  }
}

/**
 * Add detected video
 */
function addDetectedVideo(video: VideoMetadata) {
  // Check if video already exists
  if (!detectedVideos.find(v => normalizeUrl(v.url) === normalizeUrl(video.url))) {
    getOrCreateVideoId(video);
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
 * Get or generate a unique video ID
 * If video doesn't have an ID, generate one
 */
function getOrCreateVideoId(video: VideoMetadata): string {
  // Use existing videoId if available
  if (video.videoId) {
    return video.videoId;
  }
  
  // Generate a new UUID v4 for this video instance
  const videoId = uuidv4();
  video.videoId = videoId;
  return videoId;
}

/**
 * Get download state for a video
 * Uses unique video ID to match only the exact video that was downloaded
 */
function getDownloadStateForVideo(video: VideoMetadata): DownloadState | undefined {
  const videoId = video.videoId || getOrCreateVideoId(video);

  if (!videoId) {
    return undefined;
  }

  return downloadStates.find(d => d.metadata?.videoId === videoId);
}

// Quality selection functions removed - only direct downloads supported

/**
 * Render detected videos with download status
 */
function renderDetectedVideos() {
  // Deduplicate videos before rendering using normalized URLs
  const seenUrls = new Set<string>();
  const uniqueVideos = detectedVideos.filter(video => {
    const normalizedUrl = normalizeUrl(video.url);
    if (seenUrls.has(normalizedUrl)) {
      return false;
    }
    seenUrls.add(normalizedUrl);
    return true;
  });

  if (uniqueVideos.length === 0) {
    detectedVideosList.innerHTML = `
      <div class="empty-state">
        No videos detected on this page.<br>
        Use the input above to paste a video URL manually.
      </div>
    `;
    return;
  }

  detectedVideosList.innerHTML = uniqueVideos.map(video => {
    const videoId = video.videoId || getOrCreateVideoId(video);
    const downloadState = getDownloadStateForVideo(video);
    const isDownloading = downloadState && downloadState.progress.stage !== 'completed' && downloadState.progress.stage !== 'failed';
    const isCompleted = downloadState && downloadState.progress.stage === 'completed';
    const isFailed = downloadState && downloadState.progress.stage === 'failed';
    
    // Get actual file format for display (from download state or video URL)
    const actualFormat = getActualFileFormat(video, downloadState);

    const displayResolution = (video.resolution || '').trim();
    const displayWidth = video.width;
    const displayHeight = video.height;
    const displayDimensions = (!displayResolution && displayWidth && displayHeight) ? `${displayWidth}x${displayHeight}` : '';
    
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
    
    // Quality selection removed - only direct downloads supported

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
          ${displayResolution ? `<span class="video-resolution">${escapeHtml(displayResolution)}</span>` : ''}
          ${displayDimensions ? `<span class="video-resolution">${displayDimensions}</span>` : ''}
          <span class="video-link-type">${escapeHtml(getLinkTypeDisplayName(video.format))}</span>
          <span class="video-format">${escapeHtml(getFormatDisplayName(video.format, actualFormat))}</span>
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
                data-video-id="${escapeHtml(videoId)}"
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
      const videoId = button.getAttribute('data-video-id');

      let videoMetadata: VideoMetadata | undefined;
      if (videoId) {
        videoMetadata = detectedVideos.find(v => v.videoId === videoId);
      }

      if (!videoMetadata) {
        videoMetadata = detectedVideos.find(v => normalizeUrl(v.url) === normalizeUrl(url));
      }

      // Quality selection removed - only direct downloads supported
      startDownload(url, videoMetadata, { triggerButton: button });
    });
  });
}


// Error handling functions removed - errors tab removed

/**
 * Start download
 */
async function startDownload(
  url: string,
  videoMetadata?: VideoMetadata,
  options: { triggerButton?: HTMLButtonElement } = {}
) {
  const triggerButton = options.triggerButton;
  const originalText = triggerButton?.textContent;
  if (triggerButton) {
    triggerButton.disabled = true;
    triggerButton.classList.add('disabled');
    triggerButton.textContent = 'Starting...';
  }

  let shouldResetButton = false;

  try {
    // Check if extension context is still valid before sending
    if (chrome.runtime.lastError) {
      if (chrome.runtime.lastError.message?.includes('Extension context invalidated')) {
        alert('Extension was reloaded. Please refresh this page and try again.');
        shouldResetButton = true;
        return;
      }
    }
    
    const response = await new Promise<any>((resolve, reject) => {
      chrome.runtime.sendMessage({
        type: MessageType.DOWNLOAD_REQUEST,
        payload: {
          url,
          metadata: videoMetadata, // Include video metadata so download state can track which video was downloaded
        },
      }, (response) => {
        // Check for extension context invalidation
        if (chrome.runtime.lastError) {
          const errorMessage = chrome.runtime.lastError.message || '';
          if (errorMessage.includes('Extension context invalidated')) {
            reject(new Error('Extension context invalidated. Please reload the extension and try again.'));
            return;
          }
          reject(new Error(chrome.runtime.lastError.message || 'Unknown error'));
          return;
        }
        resolve(response);
      });
    }).catch((error: any) => {
      // Handle extension context invalidated
      if (error?.message?.includes('Extension context invalidated')) {
        throw new Error('Extension context invalidated. Please reload the extension and try again.');
      }
      throw error;
    });

    if (response && response.success) {
      await loadDownloadStates();
      renderDetectedVideos();
      // Don't show error popup if download started successfully
      // Progress will be updated via DOWNLOAD_PROGRESS messages
    } else if (response && response.error) {
      // Only show error if there's actually an error (like duplicate download)
      // Don't show errors for warnings that don't prevent the download
      const errorMessage = response.error;
      if (!errorMessage.includes('already') && !errorMessage.includes('in progress')) {
        alert(response.error);
      }
      // Still refresh the UI in case download state changed
      await loadDownloadStates();
      renderDetectedVideos();
      shouldResetButton = true;
    }
  } catch (error: any) {
    console.error('Download request failed:', error);
    // Check if error is due to invalidated context
    if (error?.message?.includes('Extension context invalidated') ||
        chrome.runtime.lastError?.message?.includes('Extension context invalidated')) {
      alert('Extension was reloaded. Please close and reopen this popup, then try again.');
    } else {
      alert('Failed to start download: ' + (error?.message || 'Unknown error'));
    }
    shouldResetButton = true;
  } finally {
    if (shouldResetButton && triggerButton && triggerButton.isConnected) {
      triggerButton.disabled = false;
      triggerButton.classList.remove('disabled');
      triggerButton.textContent = originalText || 'Download';
    }
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
 * Get actual file format from video URL or download state
 */
function getActualFileFormat(video: VideoMetadata, downloadState?: DownloadState): string | null {
  // First, check if download is completed and we have the local path
  if (downloadState?.localPath) {
    const ext = downloadState.localPath.split('.').pop()?.toUpperCase();
    if (ext && ['MP4', 'WEBM', 'MOV', 'AVI', 'MKV', 'FLV', 'WMV', 'OGG'].includes(ext)) {
      return ext;
    }
  }
  
  // Check video URL for file extension
  try {
    const url = new URL(video.url);
    const pathname = url.pathname.toLowerCase();
    const extensionMatch = pathname.match(/\.(mp4|webm|mov|avi|mkv|flv|wmv|ogg)(\?|$|#)/);
    if (extensionMatch && extensionMatch[1]) {
      return extensionMatch[1].toUpperCase();
    }
  } catch {
    // URL parsing failed, try simple string match
    const urlLower = video.url.toLowerCase();
    const extensionMatch = urlLower.match(/\.(mp4|webm|mov|avi|mkv|flv|wmv|ogg)(\?|$|#)/);
    if (extensionMatch && extensionMatch[1]) {
      return extensionMatch[1].toUpperCase();
    }
  }
  
  return null;
}

/**
 * Get format display name - show actual file format instead of delivery method
 */
function getFormatDisplayName(format: VideoFormat, actualFormat?: string | null): string {
  // If we have the actual file format, use it
  if (actualFormat) {
    return actualFormat;
  }
  
  // When format is "direct", it means it's a direct video file download
  // Default to MP4 if we can't determine the actual format
  if (format === 'direct') {
    return 'MP4';
  }
  
  return format.toUpperCase();
}

/**
 * Get link type display name (delivery method: direct)
 */
function getLinkTypeDisplayName(format: VideoFormat): string {
  switch (format) {
    case 'direct':
      return 'Direct';
    default:
      return 'Direct';
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
 * Calculate estimated video size from bandwidth and duration
 */
function calculateEstimatedSize(bandwidth: number, duration?: number): string {
  if (!bandwidth || bandwidth === 0 || !duration) {
    return '';
  }
  
  // bandwidth is in bits per second, convert to bytes per second
  const bytesPerSecond = bandwidth / 8;
  // Estimate total size
  const estimatedBytes = bytesPerSecond * duration;
  
  // Format size
  if (estimatedBytes < 1024) {
    return `${estimatedBytes.toFixed(0)} B`;
  } else if (estimatedBytes < 1024 * 1024) {
    return `${(estimatedBytes / 1024).toFixed(1)} KB`;
  } else if (estimatedBytes < 1024 * 1024 * 1024) {
    return `${(estimatedBytes / (1024 * 1024)).toFixed(1)} MB`;
  } else {
    return `${(estimatedBytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  }
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
