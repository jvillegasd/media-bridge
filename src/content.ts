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
  const pageUrl = video.pageUrl || window.location.href;

  // If this is a new HLS master playlist, remove any m3u8 entries from the same page
  if (video.format === "hls" && !existing) {
    const m3u8Variants = Object.entries(detectedVideos).filter(
      ([url, v]) => v.format === "m3u8" && v.pageUrl === pageUrl
    );

    // Remove m3u8 variants from the same page
    for (const [url, variant] of m3u8Variants) {
      logger.info("Removing m3u8 variant (HLS master playlist detected)", {
        m3u8Url: variant.url,
        hlsMasterUrl: video.url,
      });
      delete detectedVideos[url];
      sentToPopup.delete(url);
      // Notify popup to remove this entry
      safeSendMessage({
        type: MessageType.VIDEO_DETECTED,
        payload: { ...variant, format: "unknown" as const }, // Send as unknown to trigger removal
      });
    }
  }

  // If this is an m3u8 playlist and there's already an HLS master on the same page, ignore it
  if (video.format === "m3u8") {
    const hlsMaster = Object.values(detectedVideos).find(
      (v) => v.format === "hls" && v.pageUrl === pageUrl
    );

    if (hlsMaster) {
      logger.info("Filtering out m3u8 variant (HLS master playlist exists)", {
        m3u8Url: video.url,
        hlsMasterUrl: hlsMaster.url,
      });
      return;
    }
  }

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
  clearSentToPopupTracking();
  const currentPageVideos: Record<string, VideoMetadata> = {};
  for (const [url, video] of Object.entries(detectedVideos)) {
    if (video.pageUrl === currentUrl) {
      currentPageVideos[url] = video;
    }
  }
  detectedVideos = currentPageVideos;

  // Reset icon to gray on URL change
  safeSendMessage({
    type: MessageType.SET_ICON_GRAY,
  });
}

/**
 * Monitor page URL changes and clear videos from previous page
 */
function setupUrlChangeMonitor() {
  // Listen for popstate (back/forward navigation)
  window.addEventListener("popstate", handleUrlChange);

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
}

/**
 * Initialize content script
 * Sets up detection manager, performs initial scan, and monitors DOM changes
 */
function init() {
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
