/**
 * Content script for video detection
 * Intercepts network requests, scans DOM for video elements, and sends detected videos to popup
 */

import { MessageType } from "./shared/messages";
import { VideoMetadata } from "./core/types";
import { DetectionManager } from "./core/detection/detection-manager";
import { normalizeUrl } from "./core/utils/url-utils";

let detectedVideos: Record<string, VideoMetadata> = {};
let detectionManager: DetectionManager;
const sentToPopup = new Set<string>();

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

    try {
      chrome.runtime.sendMessage(message, (response) => {
        if (chrome.runtime.lastError) {
          const errorMessage = chrome.runtime.lastError.message || "";
          if (errorMessage.includes("Extension context invalidated")) {
            console.debug("Extension context invalidated");
            resolve();
            return;
          }
        }
        resolve();
      });
    } catch (error: any) {
      if (
        error?.message?.includes("Extension context invalidated") ||
        chrome.runtime.lastError?.message?.includes(
          "Extension context invalidated",
        )
      ) {
        console.debug("Extension context invalidated");
        resolve();
        return;
      }
      resolve();
    }
  });
}

/**
 * Process captured network request URL for video detection
 */
function handleCapturedRequest(url: string) {
  if (detectionManager) {
    detectionManager.handleNetworkRequest(url);
  }
}

/**
 * Intercept fetch and XMLHttpRequest to capture video URLs
 * Also sets up PerformanceObserver to monitor resource loading
 */
function setupNetworkInterceptor() {
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

/**
 * Set up PerformanceObserver to monitor resource loading
 * Captures URLs of loaded resources for video detection
 */
function setupResourcePerformanceObserver() {
  if (typeof PerformanceObserver === "undefined") {
    return;
  }

  try {
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        const resource = entry as PerformanceResourceTiming;
        const url = resource?.name;
        if (url) {
          handleCapturedRequest(url);
        }
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
    console.log("[Media Bridge] PerformanceObserver initialized");
  } catch (error) {
    console.debug("[Media Bridge] PerformanceObserver initialization failed:", error);
  }
}

/**
 * Initialize content script
 * Sets up detection manager, performs initial scan, and monitors DOM changes
 */
function init() {
  detectionManager = new DetectionManager({
    onVideoDetected: (video) => {
      addDetectedVideo(video);
    },
  });

  detectVideos();
  setTimeout(() => {
    detectVideos();
  }, 1000);

  const observer = new MutationObserver((mutations) => {
    let shouldDetect = false;
    for (const mutation of mutations) {
      for (const node of Array.from(mutation.addedNodes)) {
        if (node.nodeType === Node.ELEMENT_NODE) {
          const element = node as Element;
          if (element.tagName === "VIDEO" || element.querySelector("video")) {
            shouldDetect = true;
            break;
          }
        }
      }
      if (shouldDetect) break;
    }

    if (shouldDetect) {
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

  setInterval(() => {
    detectVideos();
  }, 3000);
}

/**
 * Scan DOM for video elements using DetectionManager
 * Updates existing videos with new metadata if found
 */
async function detectVideos() {
  if (!detectionManager) {
    return;
  }

  const newVideos = await detectionManager.scanDOM();

  for (const metadata of newVideos) {
    const normalizedUrl = normalizeUrl(metadata.url);
    
    if (detectedVideos[normalizedUrl]) {
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
 * Add or update detected video and notify popup
 * Uses normalized URL as unique key to prevent duplicates
 */
function addDetectedVideo(video: VideoMetadata) {
  // Reject unknown formats - don't show them in UI
  if (video.format === 'unknown') {
    return;
  }
  
  const normalizedUrl = normalizeUrl(video.url);
  const existing = detectedVideos[normalizedUrl];
  
  if (existing) {
    let updated = false;

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

    if (updated && !sentToPopup.has(normalizedUrl)) {
      sentToPopup.add(normalizedUrl);
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
 * Monitor page URL changes and clear videos from previous page
 */
let lastUrl = window.location.href;
setInterval(() => {
  const currentUrl = window.location.href;
  if (currentUrl !== lastUrl) {
    lastUrl = currentUrl;
    clearSentToPopupTracking();
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
 * Listen for messages from popup
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

    return false;
  } catch (error) {
    console.debug("Error handling message:", error);
    return false;
  }
});

setupNetworkInterceptor();

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}

