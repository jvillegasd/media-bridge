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
let sentToPopup = new Set<string>();
let lastUrl = location.href;
const inIframe = window.self !== window.top;

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
 * Remove detected video and notify popup
 */
function removeDetectedVideo(url: string): void {
  const normalizedUrl = normalizeUrl(url);

  if (detectedVideos[normalizedUrl]) {
    delete detectedVideos[normalizedUrl];
    sentToPopup.delete(normalizedUrl);

    logger.info("[Media Bridge] Removed detected video", {
      url: normalizedUrl,
    });

    // Notify popup about removal
    safeSendMessage({
      type: MessageType.VIDEO_REMOVED,
      payload: { url: normalizedUrl },
    });
  }
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

  logger.debug("[Media Bridge] normalized URL", normalizedUrl);

  // Change icon to blue when video is detected
  safeSendMessage({
    type: MessageType.SET_ICON_BLUE,
  });

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

    if (video.pageUrl !== existing.pageUrl) {
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
 * Initialize content script
 * Sets up detection manager, performs initial scan, and monitors DOM changes
 */
function init() {
  // Reset icon to gray on page load (only from top frame)
  if (!inIframe) {
    safeSendMessage({
      type: MessageType.SET_ICON_GRAY,
    });
  }

  detectionManager = new DetectionManager({
    onVideoDetected: (video) => {
      addDetectedVideo(video);
    },
    onVideoRemoved: (url) => {
      removeDetectedVideo(url);
    },
  });

  // Initialize all detection mechanisms
  detectionManager.init();
}

/**
 * Handle SPA navigation by resetting detection state
 * Covers pushState/replaceState (popstate) and Navigation API
 */
function handleNavigation(): void {
  const currentUrl = location.href;
  if (currentUrl === lastUrl) return;
  lastUrl = currentUrl;

  logger.info("[Media Bridge] SPA navigation detected, resetting detection");

  // Clean up old detection resources
  if (detectionManager) {
    detectionManager.destroy();
  }

  // Reset state
  detectedVideos = {};
  sentToPopup = new Set<string>();

  // Re-initialize
  init();
}

// Listen for SPA navigations (History API) — only in top frame
if (!inIframe) {
  window.addEventListener("popstate", handleNavigation);

  // Intercept pushState/replaceState since they don't fire popstate
  const origPushState = history.pushState.bind(history);
  const origReplaceState = history.replaceState.bind(history);
  history.pushState = function (...args) {
    origPushState(...args);
    handleNavigation();
  };
  history.replaceState = function (...args) {
    origReplaceState(...args);
    handleNavigation();
  };
}

/**
 * Listen for messages from popup and service worker
 */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
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

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
