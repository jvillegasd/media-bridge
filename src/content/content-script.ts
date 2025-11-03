/**
 * Content script for video detection and UI injection
 */

import { FormatDetector } from '../lib/downloader/format-detector';
import { MessageType } from '../shared/messages';

// Video detection state
let detectedVideos: Map<HTMLElement, string> = new Map();
let downloadButtons: Map<HTMLElement, HTMLElement> = new Map();

/**
 * Initialize content script
 */
function init() {
  detectVideos();
  
  // Watch for dynamically added videos
  const observer = new MutationObserver(() => {
    detectVideos();
  });

  observer.observe(document.body, {
    childList: true,
    subtree: true,
  });
}

/**
 * Detect videos on the page
 */
function detectVideos() {
  // Find video elements
  const videoElements = document.querySelectorAll('video');
  
  videoElements.forEach(video => {
    if (detectedVideos.has(video as HTMLElement)) {
      return; // Already processed
    }

    const videoUrl = getVideoUrl(video);
    if (videoUrl) {
      detectedVideos.set(video as HTMLElement, videoUrl);
      injectDownloadButton(video as HTMLElement, videoUrl);
    }
  });

  // Detect video URLs in source elements
  const sourceElements = document.querySelectorAll('source[src*=".m3u8"], source[src*=".mpd"]');
  
  sourceElements.forEach(source => {
    const parent = source.parentElement;
    if (parent && !detectedVideos.has(parent as HTMLElement)) {
      const url = (source as HTMLSourceElement).src;
      detectedVideos.set(parent as HTMLElement, url);
      injectDownloadButton(parent as HTMLElement, url);
    }
  });

  // Detect common video player patterns
  detectPlayerPatterns();
}

/**
 * Get video URL from video element
 */
function getVideoUrl(video: HTMLVideoElement): string | null {
  // Check src attribute
  if (video.src) {
    return video.src;
  }

  // Check source elements
  const source = video.querySelector('source');
  if (source && source.src) {
    return source.src;
  }

  // Check currentSrc
  if (video.currentSrc) {
    return video.currentSrc;
  }

  return null;
}

/**
 * Detect video URLs from common player patterns
 */
function detectPlayerPatterns() {
  // YouTube
  if (window.location.hostname.includes('youtube.com') || window.location.hostname.includes('youtu.be')) {
    detectYouTubeVideos();
  }

  // Twitter/X
  if (window.location.hostname.includes('twitter.com') || window.location.hostname.includes('x.com')) {
    detectTwitterVideos();
  }

  // Generic HLS.js/Dash.js players
  if ((window as any).Hls || (window as any).dashjs) {
    detectMediaPlayerVideos();
  }
}

/**
 * Detect YouTube videos
 */
function detectYouTubeVideos() {
  // YouTube embeds video in iframe, we need to detect the player
  const players = document.querySelectorAll('[id^="player"], [class*="ytp"]');
  
  players.forEach(player => {
    // Try to find video URL from YouTube player API
    const ytPlayer = (window as any).ytInitialPlayerResponse;
    if (ytPlayer && ytPlayer.streamingData) {
      const formats = [
        ...(ytPlayer.streamingData.adaptiveFormats || []),
        ...(ytPlayer.streamingData.formats || []),
      ];
      
      // Find video format
      const videoFormat = formats.find((f: any) => f.mimeType?.includes('video'));
      if (videoFormat && videoFormat.url) {
        const url = videoFormat.url;
        if (!Array.from(detectedVideos.values()).includes(url)) {
          detectedVideos.set(player as HTMLElement, url);
          injectDownloadButton(player as HTMLElement, url);
        }
      }
    }
  });
}

/**
 * Detect Twitter/X videos
 */
function detectTwitterVideos() {
  // Twitter embeds videos in specific containers
  const videoContainers = document.querySelectorAll('[data-testid="videoPlayer"], [data-testid="videoComponent"]');
  
  videoContainers.forEach(container => {
    const video = container.querySelector('video');
    if (video) {
      const url = getVideoUrl(video);
      if (url && !Array.from(detectedVideos.values()).includes(url)) {
        detectedVideos.set(container as HTMLElement, url);
        injectDownloadButton(container as HTMLElement, url);
      }
    }
  });
}

/**
 * Detect videos from HLS.js/Dash.js players
 */
function detectMediaPlayerVideos() {
  // Try to find video sources from player instances
  const videoElements = document.querySelectorAll('video');
  
  videoElements.forEach(video => {
    const hls = (video as any).hls;
    if (hls && hls.url) {
      const url = hls.url;
      if (url && !detectedVideos.has(video as HTMLElement)) {
        detectedVideos.set(video as HTMLElement, url);
        injectDownloadButton(video as HTMLElement, url);
      }
    }

    const dash = (video as any).dash;
    if (dash && dash.getActiveStream) {
      const stream = dash.getActiveStream();
      if (stream && stream.url) {
        const url = stream.url;
        if (url && !detectedVideos.has(video as HTMLElement)) {
          detectedVideos.set(video as HTMLElement, url);
          injectDownloadButton(video as HTMLElement, url);
        }
      }
    }
  });
}

/**
 * Inject download button next to video
 */
function injectDownloadButton(element: HTMLElement, videoUrl: string) {
  // Check if button already exists
  if (downloadButtons.has(element)) {
    return;
  }

  // Create download button
  const button = document.createElement('button');
  button.className = 'media-bridge-download-btn';
  button.innerHTML = '⬇ Download';
  button.style.cssText = `
    position: absolute;
    top: 10px;
    right: 10px;
    z-index: 9999;
    background: #4285f4;
    color: white;
    border: none;
    padding: 8px 16px;
    border-radius: 4px;
    cursor: pointer;
    font-size: 14px;
    font-weight: 500;
    box-shadow: 0 2px 4px rgba(0,0,0,0.2);
    transition: background 0.2s;
  `;

  button.addEventListener('mouseenter', () => {
    button.style.background = '#3367d6';
  });

  button.addEventListener('mouseleave', () => {
    button.style.background = '#4285f4';
  });

  button.addEventListener('click', async (e) => {
    e.stopPropagation();
    e.preventDefault();
    
    button.disabled = true;
    button.innerHTML = '⏳ Starting...';
    
    // Send download request to background
    try {
      const response = await chrome.runtime.sendMessage({
        type: MessageType.DOWNLOAD_REQUEST,
        payload: {
          url: videoUrl,
        },
      });

      if (response && response.success) {
        button.innerHTML = '✓ Queued';
        setTimeout(() => {
          button.innerHTML = '⬇ Download';
          button.disabled = false;
        }, 2000);
      } else {
        button.innerHTML = '✗ Error';
        button.style.background = '#ea4335';
        setTimeout(() => {
          button.innerHTML = '⬇ Download';
          button.disabled = false;
          button.style.background = '#4285f4';
        }, 3000);
      }
    } catch (error) {
      console.error('Download request failed:', error);
      button.innerHTML = '✗ Error';
      button.disabled = false;
    }
  });

  // Position button relative to video element
  const parent = element.parentElement;
  if (parent) {
    const container = document.createElement('div');
    container.style.position = 'relative';
    container.style.display = 'inline-block';
    
    // Wrap element if needed
    if (parent.contains(element)) {
      container.appendChild(button);
      parent.insertBefore(container, element);
      element.parentElement?.insertBefore(button, element);
    } else {
      parent.appendChild(button);
    }
    
    downloadButtons.set(element, button);
  }
}

// Initialize when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}

