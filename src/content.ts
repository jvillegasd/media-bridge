/**
 * Content script for video detection - sends detected videos to popup
 */

import { MessageType } from "./shared/messages";
import { VideoMetadata } from "./core/types";
import { DetectionManager } from "./core/detection/detection-manager";

// Video detection state
let detectedVideos: VideoMetadata[] = [];
let detectionManager: DetectionManager;

// Track videos that have been sent to popup to avoid redundant updates
const sentToPopup = new Set<string>();

// Track videos by stable identifier to prevent duplicates
const videoIdMap = new Map<string, VideoMetadata>(); // videoId -> VideoMetadata

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

  // Build set of already detected URLs to avoid duplicates within this detection run
  const detectedUrls = new Set<string>(detectedVideos.map((v) => v.url));

  // Also track by videoId to prevent duplicates even if URL changes slightly
  const existingVideoIds = new Set<string>(
    detectedVideos.map((v) => v.videoId || "").filter((id) => id),
  );

  // Use DetectionManager to scan DOM
  const newVideos = await detectionManager.scanDOM();

  for (const metadata of newVideos) {
    // Skip if we already have this video by URL
    if (detectedUrls.has(metadata.url)) {
      continue;
    }

    // Generate or get stable videoId for tracking
    if (!metadata.videoId) {
      const stableId = extractStableId(metadata.url) || metadata.url;
      metadata.videoId = stableId;
    }

    // Skip if we already have this video by videoId
    if (existingVideoIds.has(metadata.videoId)) {
      // Update existing video if needed, but don't add duplicate
      const existingVideo = detectedVideos.find(
        (v) => v.videoId === metadata.videoId,
      );
      if (existingVideo) {
        // Update URL if it changed (e.g., blob URL resolved to direct URL)
        if (metadata.url !== existingVideo.url && !metadata.url.startsWith("blob:") && !metadata.url.startsWith("data:")) {
          existingVideo.url = metadata.url;
          existingVideo.format = metadata.format;
          // Update metadata if missing
          if (!existingVideo.title && metadata.title)
            existingVideo.title = metadata.title;
          if (!existingVideo.thumbnail && metadata.thumbnail)
            existingVideo.thumbnail = metadata.thumbnail;
          if (!existingVideo.width && metadata.width)
            existingVideo.width = metadata.width;
          if (!existingVideo.height && metadata.height)
            existingVideo.height = metadata.height;
          if (!existingVideo.duration && metadata.duration)
            existingVideo.duration = metadata.duration;
          if (!existingVideo.resolution && metadata.resolution)
            existingVideo.resolution = metadata.resolution;

          addDetectedVideo(existingVideo);
        }
        continue;
      }
    }

    console.log("[Media Bridge] Detected video:", {
      url: metadata.url,
      format: metadata.format,
      videoId: metadata.videoId,
      pageUrl: metadata.pageUrl,
    });

    // Track both identifier and final URL to avoid duplicates in subsequent runs
    detectedUrls.add(metadata.url);
    existingVideoIds.add(metadata.videoId);

    addDetectedVideo(metadata);
  }
}

/**
 * Extract stable identifier from URL (works generically across sites)
 */
function extractStableId(url: string): string | null {
  // Look for common ID patterns in URLs (works across many sites)
  const patterns = [
    /\/(?:status|post|video|watch|id|p)\/([^\/?#]+)/, // Twitter, Instagram, YouTube, etc.
    /[#&]video[=#]([^&?#]+)/, // Video ID in hash/query
    /\/embed\/([^\/?#]+)/, // Embed IDs
  ];

  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match && match[1]) {
      return match[1];
    }
  }

  return null;
}

/**
 * Add detected video and notify popup (generic duplicate detection)
 */
function addDetectedVideo(video: VideoMetadata) {
  // Ensure video has a stable ID
  if (!video.videoId) {
    video.videoId = extractStableId(video.url) || video.url;
  }

  // Check if already exists by videoId (most reliable)
  let existingIndex = -1;
  if (video.videoId) {
    existingIndex = detectedVideos.findIndex(
      (v) => v.videoId === video.videoId,
    );
  }

  // Fallback: check by URL if no videoId match
  if (existingIndex < 0) {
    existingIndex = detectedVideos.findIndex((v) => v.url === video.url);
  }

  // Fallback: check by stable ID pattern if URL contains one
  if (existingIndex < 0) {
    const videoId = extractStableId(video.url);
    if (videoId) {
      existingIndex = detectedVideos.findIndex((v) => {
        const vId = extractStableId(v.url) || v.videoId;
        return vId && vId === videoId && v.pageUrl === video.pageUrl;
      });
    }
  }

  if (existingIndex >= 0) {
    // Update existing entry - keep the same object reference to prevent flickering
    const existing = detectedVideos[existingIndex];

    // Update title - prefer browser tab title (document.title) over any other title
    // Browser tab title is more reliable and consistent
    if (
      video.title === document.title ||
      !existing.title ||
      existing.title.trim().length === 0
    ) {
      existing.title = video.title || document.title;
    }

    // Update other metadata if missing
    let updated = false;
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
      // Update normally
      existing.url = video.url;
      existing.format = video.format;
      updated = true;
    }

    // Update videoId if missing
    if (!existing.videoId && video.videoId) {
      existing.videoId = video.videoId;
    }

    // Only send update if something meaningful changed AND we haven't sent this recently
    // Use videoId as key for tracking sent videos
    const trackingKey = existing.videoId || existing.url;
    if (updated && !sentToPopup.has(trackingKey)) {
      sentToPopup.add(trackingKey);
      safeSendMessage({
        type: MessageType.VIDEO_DETECTED,
        payload: existing,
      });
    }

    return;
  }

  // New video - add to list
  detectedVideos.push(video);

  // Track in videoIdMap
  if (video.videoId) {
    videoIdMap.set(video.videoId, video);
  }

  // Only send to popup if we haven't sent this video recently
  const trackingKey = video.videoId || video.url;
  if (!sentToPopup.has(trackingKey)) {
    sentToPopup.add(trackingKey);

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
  videoIdMap.clear();
}

// Clear tracking when page URL changes
let lastUrl = window.location.href;
setInterval(() => {
  const currentUrl = window.location.href;
  if (currentUrl !== lastUrl) {
    lastUrl = currentUrl;
    clearSentToPopupTracking();
    // Also clear detected videos from previous page
    detectedVideos = detectedVideos.filter((v) => v.pageUrl === currentUrl);
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
      sendResponse({ videos: detectedVideos });
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

