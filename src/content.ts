/**
 * Content script for video detection - sends detected videos to popup
 */

import { MessageType } from "./shared/messages";
import { VideoMetadata } from "./core/types";
import { DetectionManager } from "./core/detection/detection-manager";
import { normalizeUrl } from "./core/utils/url-utils";

// Video detection state - using URL as the unique key
let detectedVideos: Record<string, VideoMetadata> = {}; // url -> VideoMetadata
let detectionManager: DetectionManager;

// Track videos that have been sent to popup to avoid redundant updates
const sentToPopup = new Set<string>();

/**
 * Safely send message to runtime, handling extension context invalidation
 */
function safeSendMessage(message: any): Promise<void> {
  return new Promise((resolve) => {
    // Check if runtime is available
    if (!chrome?.runtime?.sendMessage) {
      console.debug("Chrome runtime not available");
      resolve();
      return;
    }

    try {
      chrome.runtime.sendMessage(message, (response) => {
        // Check for extension context invalidation
        if (chrome.runtime.lastError) {
          const errorMessage = chrome.runtime.lastError.message || "";
          if (errorMessage.includes("Extension context invalidated")) {
            console.debug(
              "Extension context invalidated, cannot send messages",
            );
            resolve();
            return;
          }
          // Other errors (popup not open, etc.) - ignore silently
        }
        resolve();
      });
    } catch (error: any) {
      // Handle extension context invalidated error
      if (
        error?.message?.includes("Extension context invalidated") ||
        chrome.runtime.lastError?.message?.includes(
          "Extension context invalidated",
        )
      ) {
        console.debug("Extension context invalidated, cannot send messages");
        resolve();
        return;
      }
      // Other errors - ignore silently
      resolve();
    }
  });
}

/**
 * Handle network request for video detection
 */
function handleCapturedRequest(url: string) {
  if (detectionManager) {
    detectionManager.handleNetworkRequest(url);
  }
}

/**
 * Intercept fetch/XHR requests to capture video URLs
 */
function setupNetworkInterceptor() {
  // Intercept fetch requests
  const originalFetch = window.fetch;
  window.fetch = async function (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> {
    let url: string | null = null;
    if (typeof input === "string") {
      url = input;
    } else if (input instanceof URL) {
      url = input.href;
    } else if (input instanceof Request) {
      url = input.url;
    }

    if (url) {
      handleCapturedRequest(url);
    }
    return originalFetch.call(this, input, init);
  };

  // Also intercept XMLHttpRequest
  const originalXHROpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (
    method: string,
    url: string | URL,
    async?: boolean,
    username?: string | null,
    password?: string | null,
  ) {
    const urlString = typeof url === "string" ? url : url.toString();
    if (urlString) {
      handleCapturedRequest(urlString);
    }
    return originalXHROpen.call(
      this,
      method,
      url,
      async !== undefined ? async : true,
      username,
      password,
    );
  };

  setupResourcePerformanceObserver();
}

function setupResourcePerformanceObserver() {
  // PerformanceObserver is not supported in all environments (e.g., older browsers)
  if (typeof PerformanceObserver === "undefined") {
    return;
  }

  try {
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        const resource = entry as PerformanceResourceTiming;
        const url = resource?.name;
        if (!url) {
          continue;
        }

        handleCapturedRequest(url);
      }
    });

    try {
      observer.observe({
        type: "resource",
        buffered: true,
      } as PerformanceObserverInit);
    } catch (err) {
      try {
        observer.observe({ type: "resource" } as PerformanceObserverInit);
      } catch (err2) {
        observer.observe({ entryTypes: ["resource"] });
      }
    }
    console.log(
      "[Media Bridge] Resource PerformanceObserver initialized for video capture",
    );
  } catch (error) {
    console.debug(
      "[Media Bridge] Failed to initialize PerformanceObserver for resources:",
      error,
    );
  }
}

/**
 * Initialize content script
 */
function init() {
  // Initialize detection manager
  detectionManager = new DetectionManager({
    onVideoDetected: (video) => {
      addDetectedVideo(video);
    },
  });

  // Network interceptor is already set up (before DOM ready)
  // Initial detection with delay to allow page to load
  setTimeout(() => {
    detectVideos();
  }, 1000);

  // Also detect immediately for fast-loading pages
  detectVideos();

  // Watch for dynamically added videos (generic approach)
  const observer = new MutationObserver((mutations) => {
    // Only trigger if video elements are added
    let shouldDetect = false;
    for (const mutation of mutations) {
      for (const node of Array.from(mutation.addedNodes)) {
        if (node.nodeType === Node.ELEMENT_NODE) {
          const element = node as Element;
          // Generic check: video element or container with video element
          if (element.tagName === "VIDEO" || element.querySelector("video")) {
            shouldDetect = true;
            break;
          }
        }
      }
      if (shouldDetect) break;
    }

    if (shouldDetect) {
      // Debounce to avoid excessive calls
      clearTimeout((observer as any).timeout);
      (observer as any).timeout = setTimeout(() => {
        detectVideos();
      }, 1000);
    }
  });

  observer.observe(document.body, {
    childList: true,
    subtree: true,
  });

  // Retry detection periodically for pages that load data dynamically (YouTube, Twitter)
  // This allows detection during scrolling to catch new videos
  setInterval(() => {
    detectVideos();
  }, 3000);
}

/**
 * Detect videos on the page
 */
async function detectVideos() {
  if (!detectionManager) {
    return;
  }

  // Use DetectionManager to scan DOM
  const newVideos = await detectionManager.scanDOM();

  for (const metadata of newVideos) {
    // Normalize URL to use as key
    const normalizedUrl = normalizeUrl(metadata.url);
    
    // Pre-check: Skip if we already have this video by URL
    if (detectedVideos[normalizedUrl]) {
      // Update existing video metadata if needed
      const existing = detectedVideos[normalizedUrl];
      let updated = false;
      
      if (!existing.title && metadata.title) {
        existing.title = metadata.title;
        updated = true;
      }
      if (!existing.thumbnail && metadata.thumbnail) {
        existing.thumbnail = metadata.thumbnail;
        updated = true;
      }
      if (!existing.width && metadata.width) {
        existing.width = metadata.width;
        updated = true;
      }
      if (!existing.height && metadata.height) {
        existing.height = metadata.height;
        updated = true;
      }
      if (!existing.duration && metadata.duration) {
        existing.duration = metadata.duration;
        updated = true;
      }
      if (!existing.resolution && metadata.resolution) {
        existing.resolution = metadata.resolution;
        updated = true;
      }
      
      // Only dispatch if something meaningful changed
      if (updated) {
        addDetectedVideo(existing);
      }
      continue;
    }

    console.log("[Media Bridge] Detected video:", {
      url: metadata.url,
      format: metadata.format,
      pageUrl: metadata.pageUrl,
    });

    addDetectedVideo(metadata);
  }
}


/**
 * Add detected video and notify popup
 * Uses URL as the unique key - pre-checks before adding/dispatching
 */
function addDetectedVideo(video: VideoMetadata) {
  // Normalize URL to use as key
  const normalizedUrl = normalizeUrl(video.url);
  
  // Pre-check: Check if already exists by URL
  const existing = detectedVideos[normalizedUrl];
  
  if (existing) {
    // Update existing entry metadata if needed
    let updated = false;

    // Update title - prefer browser tab title (document.title) over any other title
    if (
      video.title === document.title ||
      !existing.title ||
      existing.title.trim().length === 0
    ) {
      existing.title = video.title || document.title;
      updated = true;
    }

    // Update other metadata if missing
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

    // Update URL if it changed (e.g., blob URL resolved to direct URL)
    if (
      video.url !== existing.url &&
      !video.url.startsWith("blob:") &&
      !video.url.startsWith("data:")
    ) {
      // Update URL and format
      existing.url = video.url;
      existing.format = video.format;
      updated = true;
    }

    // Only send update if something meaningful changed AND we haven't sent this recently
    if (updated && !sentToPopup.has(normalizedUrl)) {
      sentToPopup.add(normalizedUrl);
      safeSendMessage({
        type: MessageType.VIDEO_DETECTED,
        payload: existing,
      });
    }

    return;
  }

  // New video - add to store using URL as key
  detectedVideos[normalizedUrl] = video;

  // Pre-check before dispatching: Only send to popup if we haven't sent this video recently
  if (!sentToPopup.has(normalizedUrl)) {
    sentToPopup.add(normalizedUrl);

    // Send to popup
    safeSendMessage({
      type: MessageType.VIDEO_DETECTED,
      payload: video,
    });
  }
}

/**
 * Clear sent-to-popup tracking when page changes (to allow re-detection on navigation)
 */
function clearSentToPopupTracking() {
  sentToPopup.clear();
}

// Clear tracking when page URL changes
let lastUrl = window.location.href;
setInterval(() => {
  const currentUrl = window.location.href;
  if (currentUrl !== lastUrl) {
    lastUrl = currentUrl;
    clearSentToPopupTracking();
    // Also clear detected videos from previous page
    const currentPageVideos: Record<string, VideoMetadata> = {};
    for (const [url, video] of Object.entries(detectedVideos)) {
      if (video.pageUrl === currentUrl) {
        currentPageVideos[url] = video;
      }
    }
    detectedVideos = currentPageVideos;
  }
}, 1000);


/**
 * Listen for messages from popup and background script
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

    // Handle video detection from background script (webRequest)
    // DetectionManager will route to the appropriate handler based on format
    if (message.type === MessageType.VIDEO_DETECTED && message.payload) {
      const payload = message.payload;
      // Process any detected video format through DetectionManager
      if (payload.url && detectionManager) {
        detectionManager.handleNetworkRequest(payload.url);
      }
      return false;
    }

    return false;
  } catch (error) {
    console.debug("Error handling message:", error);
    return false;
  }
});

// Set up network interceptor IMMEDIATELY before DOM is ready
setupNetworkInterceptor();

// Initialize when DOM is ready
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}

