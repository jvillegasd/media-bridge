/**
 * Content script for video detection
 * Intercepts network requests, scans DOM for video elements, and sends detected videos to popup
 */

import { MessageType } from "./shared/messages";
import { VideoMetadata } from "./core/types";
import { DetectionManager } from "./core/detection/detection-manager";
import { normalizeUrl } from "./core/utils/url-utils";
import { logger } from "./core/utils/logger";

let detectedVideos: Record<string, VideoMetadata> = {};
let detectionManager: DetectionManager;
const sentToPopup = new Set<string>();
let lastKnownUrl = window.location.href;

function isInIframe(): boolean {
  return window.location !== window.parent.location;
}

/**
 * Send message to popup with error handling for extension context invalidation
 */
function safeSendMessage(message: any): Promise<void> {
  return new Promise((resolve) => {
    if (!chrome?.runtime?.sendMessage) {
      console.debug("Chrome runtime not available");
      resolve();
      return;
    }

    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) {
        const errorMessage = chrome.runtime.lastError.message || "";
        if (errorMessage.includes("Extension context invalidated")) {
          console.debug("Extension context invalidated");
        }
        resolve();
        return;
      }
      resolve();
    });
  });
}

/**
 * Add or update detected video and notify popup
 * Uses normalized URL as unique key to prevent duplicates
 */
function addDetectedVideo(video: VideoMetadata) {
  // Reject unknown formats - don't show them in UI
  if (video.format === "unknown") {
    return;
  }

  const normalizedUrl = normalizeUrl(video.url);
  const existing = detectedVideos[normalizedUrl];

  // Change icon to blue when video is detected
  safeSendMessage({
    type: MessageType.SET_ICON_BLUE,
  });
  logger.info("normalizedUrl", { normalizedUrl });
  logger.info("Adding detected video", { video });
  logger.info("already detected videos", { detectedVideos });

  if (existing) {
    let updated = false;
    logger.info("Updating video metadata", { existing, video });

    if (
      video.title === document.title ||
      !existing.title ||
      existing.title.trim().length === 0
    ) {
      existing.title = video.title || document.title;
      updated = true;
    }

    if (!existing.thumbnail && video.thumbnail) {
      existing.thumbnail = video.thumbnail;
      updated = true;
    }
    if (!existing.width && video.width) {
      existing.width = video.width;
      updated = true;
    }
    if (!existing.height && video.height) {
      existing.height = video.height;
      updated = true;
    }
    if (!existing.duration && video.duration) {
      existing.duration = video.duration;
      updated = true;
    }
    if (!existing.resolution && video.resolution) {
      existing.resolution = video.resolution;
      updated = true;
    }

    if (
      video.url !== existing.url &&
      !video.url.startsWith("blob:") &&
      !video.url.startsWith("data:")
    ) {
      existing.url = video.url;
      existing.format = video.format;
      updated = true;
    }

    if (video.pageUrl && video.pageUrl !== existing.pageUrl) {
      existing.pageUrl = video.pageUrl;
      updated = true;
    }

    // Only notify popup if metadata was actually updated
    // This prevents unnecessary updates that could cause flickering
    if (updated) {
      safeSendMessage({
        type: MessageType.VIDEO_DETECTED,
        payload: existing,
      });
    }

    return;
  }

  detectedVideos[normalizedUrl] = video;

  if (!sentToPopup.has(normalizedUrl)) {
    sentToPopup.add(normalizedUrl);
    safeSendMessage({
      type: MessageType.VIDEO_DETECTED,
      payload: video,
    });
  }
}

/**
 * Clear sent-to-popup tracking to allow re-detection on navigation
 */
function clearSentToPopupTracking() {
  sentToPopup.clear();
}

/**
 * Handle URL change - clear videos from previous page
 */
function handleUrlChange() {
  const currentUrl = window.location.href;
  
  lastKnownUrl = currentUrl;
  clearSentToPopupTracking();
  
  // Clear all detected videos (they're from the previous page)
  detectedVideos = {};

  // Reset icon to gray on URL change (popup will refresh and see empty state)
  safeSendMessage({
    type: MessageType.SET_ICON_GRAY,
  });

  logger.info("Cleared detected videos on URL change", { 
    newUrl: currentUrl,
    detectedVideos 
  });
}

/**
 * Monitor page URL changes and clear videos from previous page
 */
function setupUrlChangeMonitor() {
  // Listen for popstate (back/forward navigation)
  window.addEventListener("popstate", handleUrlChange);

  // Listen for hashchange (hash-based navigation)
  window.addEventListener("hashchange", handleUrlChange);

  // Intercept pushState and replaceState for programmatic navigation
  const originalPushState = history.pushState;
  history.pushState = function (...args) {
    originalPushState.apply(history, args);
    handleUrlChange();
  };

  const originalReplaceState = history.replaceState;
  history.replaceState = function (...args) {
    originalReplaceState.apply(history, args);
    handleUrlChange();
  };

  // MutationObserver to detect URL changes via DOM mutations
  // This catches cases where URL changes but events don't fire
  new MutationObserver(() => {
    const url = location.href;
    if (url !== lastKnownUrl) {
      lastKnownUrl = url;
      handleUrlChange();
    }
  }).observe(document, { subtree: true, childList: true });

  // Initialize lastKnownUrl on first load
  lastKnownUrl = window.location.href;
}

/**
 * Initialize content script
 * Sets up detection manager, performs initial scan, and monitors DOM changes
 */
function init() {
  // Initialize lastKnownUrl on first load
  // Note: For full page navigations, content script is reloaded, so this will be the new URL
  lastKnownUrl = window.location.href;

  // Reset icon to gray on page load
  safeSendMessage({
    type: MessageType.SET_ICON_GRAY,
  });

  detectionManager = new DetectionManager({
    onVideoDetected: (video) => {
      addDetectedVideo(video);
    },
  });

  // Initialize all detection mechanisms
  detectionManager.init();

  setupUrlChangeMonitor();
}

/**
 * Listen for messages from popup and service worker
 */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (isInIframe()) {
    console.debug("In iframe context");
    return true;
  }

  // Check if extension context is still valid
  if (chrome.runtime.lastError) {
    const errorMessage = chrome.runtime.lastError.message || "";
    if (errorMessage.includes("Extension context invalidated")) {
      console.debug("Extension context invalidated");
      return false;
    }
    console.debug("Extension context error:", errorMessage);
    return false;
  }

  try {
    if (message.type === MessageType.GET_DETECTED_VIDEOS) {
      // Convert Record to array for response
      sendResponse({ videos: Object.values(detectedVideos) });
      return true; // Keep channel open for async response
    }

    if (message.type === MessageType.NETWORK_URL_DETECTED) {
      // Handle URL detected from service worker network interceptor
      const url = message.payload?.url;
      if (url && detectionManager) {
        // Process URL through detection manager
        detectionManager.handleNetworkRequest(url);
      }
      return false; // No response needed
    }

    return false;
  } catch (error) {
    console.debug("Error handling message:", error);
    return false;
  }
});

if (!isInIframe()) {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
}
