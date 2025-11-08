/**
 * Content script for video detection - sends detected videos to popup
 */

import { FormatDetector } from '../core/downloader/format-detector';
import { MessageType } from '../shared/messages';
import { VideoFormat, VideoMetadata } from '../core/types';
import { v4 as uuidv4 } from 'uuid';

// Video detection state
let detectedVideos: VideoMetadata[] = [];
const capturedVideoUrls = new Map<HTMLVideoElement, string>(); // Map video element -> actual video URL

// Track videos that have been sent to popup to avoid redundant updates
const sentToPopup = new Set<string>();

// Track videos by stable identifier to prevent duplicates
const videoIdMap = new Map<string, VideoMetadata>(); // videoId -> VideoMetadata

// Pending playlist captures are no longer needed - only direct downloads supported

// Track recently processed URLs so we don't spam the same capture repeatedly
const RECENT_CAPTURE_TTL_MS = 5_000;
const recentCapturedUrls = new Map<string, number>();

function pruneRecentCapturedUrls(now: number) {
  for (const [capturedUrl, timestamp] of recentCapturedUrls) {
    if (now - timestamp > RECENT_CAPTURE_TTL_MS) {
      recentCapturedUrls.delete(capturedUrl);
    }
  }
}

function registerCapturedUrl(url: string): boolean {
  const now = Date.now();
  pruneRecentCapturedUrls(now);

  const lastSeen = recentCapturedUrls.get(url);
  if (lastSeen && now - lastSeen < RECENT_CAPTURE_TTL_MS) {
    return false;
  }

  recentCapturedUrls.set(url, now);
  return true;
}

// Playlist functions removed - only direct downloads supported

/**
 * Safely send message to runtime, handling extension context invalidation
 */
function safeSendMessage(message: any): Promise<void> {
  return new Promise((resolve) => {
    // Check if runtime is available
    if (!chrome?.runtime?.sendMessage) {
      console.debug('Chrome runtime not available');
      resolve();
      return;
    }

    try {
      chrome.runtime.sendMessage(message, (response) => {
        // Check for extension context invalidation
        if (chrome.runtime.lastError) {
          const errorMessage = chrome.runtime.lastError.message || '';
          if (errorMessage.includes('Extension context invalidated')) {
            console.debug('Extension context invalidated, cannot send messages');
            resolve();
            return;
          }
          // Other errors (popup not open, etc.) - ignore silently
        }
        resolve();
      });
    } catch (error: any) {
      // Handle extension context invalidated error
      if (error?.message?.includes('Extension context invalidated') ||
          chrome.runtime.lastError?.message?.includes('Extension context invalidated')) {
        console.debug('Extension context invalidated, cannot send messages');
        resolve();
        return;
      }
      // Other errors - ignore silently
      resolve();
    }
  });
}

function normalizeFormat(format: VideoFormat): VideoFormat {
  if (format === 'unknown') {
    return 'direct';
  }
  return format;
}

function isDirectVideoUrl(url: string): boolean {
  return url.includes('.mp4') || url.includes('.webm') || url.includes('.mov') ||
                         url.includes('.avi') || url.includes('.mkv') || url.includes('.flv') ||
                         url.includes('.wmv') || url.includes('.ogg');
}




function handleDirectCapture(url: string) {
  if (!registerCapturedUrl(url)) {
    return;
  }

  console.log('[Media Bridge] Captured direct video URL:', url);

            const videoElements = document.querySelectorAll('video');
  let storedToVideoElement = false;

            for (const video of Array.from(videoElements)) {
              const vid = video as HTMLVideoElement;
        const existing = capturedVideoUrls.get(vid);
    if (!existing || existing.startsWith('blob:') || existing.startsWith('data:')) {
      capturedVideoUrls.set(vid, url);
      storedToVideoElement = true;
      console.log('[Media Bridge] Stored direct video URL for video element:', url);
          }
        }

      let updatedExistingVideo = false;
            for (const existingVideo of detectedVideos) {
          const needsUpdate = !isDirectVideoUrl(existingVideo.url) &&
                                 (existingVideo.pageUrl === window.location.href ||
                                  (existingVideo.pageUrl && window.location.href.includes(existingVideo.pageUrl)));
              
              if (needsUpdate) {
      existingVideo.url = url;
      existingVideo.format = normalizeFormat('direct');
          updatedExistingVideo = true;
                
                safeSendMessage({
                  type: MessageType.VIDEO_DETECTED,
                  payload: existingVideo,
                });
                break;
              }
            }
            
  if (!updatedExistingVideo) {
    const delay = videoElements.length > 0 ? 100 : 500;
    setTimeout(() => detectVideos(), delay);
            }
          }

function handleCapturedRequest(url: string) {
  const lowerUrl = url.toLowerCase();

  if (isDirectVideoUrl(lowerUrl)) {
    handleDirectCapture(url);
  }
}
      
/**
 * Intercept fetch/XHR requests to capture video URLs
 */
function setupNetworkInterceptor() {
  // Intercept fetch requests
  const originalFetch = window.fetch;
  window.fetch = async function(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    let url: string | null = null;
    if (typeof input === 'string') {
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
  XMLHttpRequest.prototype.open = function(method: string, url: string | URL, async?: boolean, username?: string | null, password?: string | null) {
    const urlString = typeof url === 'string' ? url : url.toString();
    if (urlString) {
      handleCapturedRequest(urlString);
    }
    return originalXHROpen.call(this, method, url, async !== undefined ? async : true, username, password);
  };

  setupResourcePerformanceObserver();
        }

function setupResourcePerformanceObserver() {
  // PerformanceObserver is not supported in all environments (e.g., older browsers)
  if (typeof PerformanceObserver === 'undefined') {
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

        const lower = url.toLowerCase();
        if (isDirectVideoUrl(lower)) {
          handleCapturedRequest(url);
        }
      }
    });

    try {
      observer.observe({ type: 'resource', buffered: true } as PerformanceObserverInit);
    } catch (err) {
      try {
        observer.observe({ type: 'resource' } as PerformanceObserverInit);
      } catch (err2) {
        observer.observe({ entryTypes: ['resource'] });
      }
    }
    console.log('[Media Bridge] Resource PerformanceObserver initialized for video capture');
  } catch (error) {
    console.debug('[Media Bridge] Failed to initialize PerformanceObserver for resources:', error);
  }
}

/**
 * Initialize content script
 */
function init() {
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
          if (element.tagName === 'VIDEO' || element.querySelector('video')) {
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
 * Generate a stable unique identifier for a video element (generic across all sites)
 */
function generateVideoId(video: HTMLVideoElement, pageUrl: string): string {
  // For blob URLs, try to find a stable identifier from the page context
  const videoUrl = getVideoUrl(video);
  if (videoUrl && videoUrl.startsWith('blob:')) {
    // Try to find a container with an ID or data attribute
    let container = video.parentElement;
    let depth = 0;
    while (container && depth < 5) {
      // Look for common container patterns with IDs
      const containerId = container.id || container.getAttribute('data-id');
      
      if (containerId) {
        return `${pageUrl}#${containerId}`;
      }
      
      // Look for links that might indicate a stable URL (status posts, post IDs, etc.)
      // Generic pattern that works across many sites
      const link = container.querySelector('a[href]');
      if (link) {
        const href = link.getAttribute('href');
        if (href && !href.startsWith('#')) {
          // Extract any ID-like patterns from the URL (e.g., /status/123, /post/456, /video/789)
          const idMatch = href.match(/\/(?:status|post|video|watch|id|p|v)\/([^\/?#]+)/);
          if (idMatch && idMatch[1]) {
            return `${pageUrl}#${idMatch[1]}`;
          }
        }
      }
      
      container = container.parentElement;
      depth++;
    }
    
    // Fallback: use video's position in DOM and its dimensions for stability
    const videos = Array.from(document.querySelectorAll('video'));
    const videoIndex = videos.indexOf(video);
    const dimensions = `${video.videoWidth || 0}x${video.videoHeight || 0}`;
    return `${pageUrl}#video-${videoIndex}-${dimensions}`;
  }
  
  // For non-blob URLs, use the URL itself
  const finalUrl = videoUrl || `${pageUrl}#video-${Date.now()}`;
  return finalUrl;
}

/**
 * Detect videos on the page
 */
async function detectVideos() {
  // Build set of already detected URLs to avoid duplicates within this detection run
  const detectedUrls = new Set<string>(detectedVideos.map(v => v.url));
  
  // Also track by videoId to prevent duplicates even if URL changes slightly
  const existingVideoIds = new Set<string>(detectedVideos.map(v => v.videoId || '').filter(id => id));
  
  // Find video elements generically
  const videoElements = document.querySelectorAll('video');
  
  for (const video of Array.from(videoElements)) {
    const vid = video as HTMLVideoElement;
    
    // Skip very small videos (likely icons or UI elements) - generic check
    if (vid.videoWidth > 0 && vid.videoHeight > 0 && 
        (vid.videoWidth < 50 || vid.videoHeight < 50)) {
      continue;
    }
    
    // Skip if video element isn't ready (but still process if dimensions are 0 but it might load)
    // Only skip if it's clearly not a video
    if (vid.readyState === 0 && !getVideoUrl(vid)) {
      continue;
    }
    
    // Get direct video URL
    let videoUrl: string | null = null;
    
    // Check captured URLs for direct video
    let capturedUrl = capturedVideoUrls.get(vid);
    if (capturedUrl && isDirectVideoUrl(capturedUrl)) {
      videoUrl = capturedUrl;
      console.log('[Media Bridge] Using captured direct video URL:', videoUrl);
    }
    
    // Fallback to getVideoUrl() for direct video links
    if (!videoUrl) {
      const fallbackUrl = getVideoUrl(vid);
      if (fallbackUrl && isDirectVideoUrl(fallbackUrl)) {
        videoUrl = fallbackUrl;
        console.log('[Media Bridge] Using direct video URL from video element:', videoUrl);
      }
    }
    
    const isRealUrl = videoUrl && !videoUrl.startsWith('blob:') && !videoUrl.startsWith('data:');
    
    // If we don't have a real URL for a direct video, skip it (can't download page URLs)
    if (!isRealUrl && !videoUrl) {
      console.log('[Media Bridge] Skipping video - no real URL found');
      continue;
    }
    
    // For blob URLs, check if we have any captured direct video URL, otherwise skip
    if (!isRealUrl && videoUrl && videoUrl.startsWith('blob:')) {
      const captured = capturedVideoUrls.get(vid);
      if (captured && isDirectVideoUrl(captured)) {
        videoUrl = captured;
        console.log('[Media Bridge] Using captured video URL instead of blob URL:', videoUrl);
      } else {
        console.log('[Media Bridge] Skipping video - only blob URL found and no direct video URL captured');
        continue;
      }
    }
    
    // Re-check isRealUrl after potentially replacing blob URL with captured URL
    const finalIsRealUrl = videoUrl && !videoUrl.startsWith('blob:') && !videoUrl.startsWith('data:');
    
    const videoIdentifier = finalIsRealUrl
      ? (videoUrl as string)
      : generateVideoId(vid, window.location.href);

    if (detectedUrls.has(videoIdentifier)) {
      continue;
    }

    const metadata = await extractVideoMetadata(vid, finalIsRealUrl ? (videoUrl as string) : videoIdentifier);
    if (!metadata) {
      continue;
    }

    let finalUrl = metadata.url;
    if (finalIsRealUrl) {
      finalUrl = videoUrl as string;
    }

    const finalFormat = normalizeFormat(FormatDetector.detectFromUrl(finalUrl));
    
    // Double-check: don't allow page URLs as direct video URLs
    // If the URL looks like a page URL and format is direct, skip this video
    if (finalFormat === 'direct') {
      try {
        const urlObj = new URL(finalUrl);
        // Check if it's the same domain as page URL and doesn't look like a video file
        const isSameDomain = urlObj.hostname === new URL(window.location.href).hostname;
        const looksLikePageUrl = finalUrl === window.location.href || 
                                 finalUrl.startsWith(window.location.href + '#') ||
                                 (!finalUrl.includes('.mp4') && !finalUrl.includes('.webm') && !finalUrl.includes('.mov') && !finalUrl.includes('.avi') && !finalUrl.includes('.mkv'));
        
        if (isSameDomain && looksLikePageUrl && !finalUrl.includes('/seg-')) {
          console.log('[Media Bridge] Skipping video - URL appears to be a page URL:', finalUrl);
          continue;
        }
      } catch (e) {
        // URL parsing failed, but if it's not a real URL, skip it
        if (!finalIsRealUrl) {
          console.log('[Media Bridge] Skipping video - invalid URL format');
          continue;
        }
      }
    }
    
    metadata.url = finalUrl;
    metadata.format = finalFormat;
    
    // Generate or get stable videoId for tracking
    if (!metadata.videoId) {
      const stableId = extractStableId(finalUrl) || videoIdentifier;
      metadata.videoId = stableId;
    }
    
    // Skip if we already have this video by videoId
    if (existingVideoIds.has(metadata.videoId)) {
      // Update existing video if needed, but don't add duplicate
      const existingVideo = detectedVideos.find(v => v.videoId === metadata.videoId);
      if (existingVideo) {
        // Update URL if it changed (e.g., blob URL resolved to direct URL)
        if (finalUrl !== existingVideo.url && finalIsRealUrl) {
          // Update normally
          existingVideo.url = finalUrl;
          existingVideo.format = finalFormat;
          // Update metadata if missing
          if (!existingVideo.title && metadata.title) existingVideo.title = metadata.title;
          if (!existingVideo.thumbnail && metadata.thumbnail) existingVideo.thumbnail = metadata.thumbnail;
          if (!existingVideo.width && metadata.width) existingVideo.width = metadata.width;
          if (!existingVideo.height && metadata.height) existingVideo.height = metadata.height;
          if (!existingVideo.duration && metadata.duration) existingVideo.duration = metadata.duration;
          if (!existingVideo.resolution && metadata.resolution) existingVideo.resolution = metadata.resolution;
          
          addDetectedVideo(existingVideo);
        } else {
          // URL unchanged, just update metadata
          existingVideo.url = finalUrl;
          existingVideo.format = finalFormat;
          // Update metadata if missing
          if (!existingVideo.title && metadata.title) existingVideo.title = metadata.title;
          if (!existingVideo.thumbnail && metadata.thumbnail) existingVideo.thumbnail = metadata.thumbnail;
          if (!existingVideo.width && metadata.width) existingVideo.width = metadata.width;
          if (!existingVideo.height && metadata.height) existingVideo.height = metadata.height;
          if (!existingVideo.duration && metadata.duration) existingVideo.duration = metadata.duration;
          if (!existingVideo.resolution && metadata.resolution) existingVideo.resolution = metadata.resolution;
          
          addDetectedVideo(existingVideo);
        }
        continue;
      }
    }
    
    console.log('[Media Bridge] Detected video:', {
      url: finalUrl,
      format: finalFormat,
      videoId: metadata.videoId,
      pageUrl: metadata.pageUrl
    });

    // Track both identifier and final URL to avoid duplicates in subsequent runs
    detectedUrls.add(videoIdentifier);
    detectedUrls.add(finalUrl);
    existingVideoIds.add(metadata.videoId);

    addDetectedVideo(metadata);
  }

  // Source element detection removed - only direct downloads supported

}

/**
 * Extract video metadata from video element (generic approach)
 */
async function extractVideoMetadata(video: HTMLVideoElement, url: string): Promise<VideoMetadata | null> {
  const rawFormat = FormatDetector.detectFromUrl(url);
  const normalizedFormat = normalizeFormat(rawFormat);
  
  const metadata: VideoMetadata = {
    url,
    format: normalizedFormat,
    pageUrl: window.location.href,
    width: video.videoWidth || undefined,
    height: video.videoHeight || undefined,
    duration: video.duration || undefined,
    // Default to browser tab title for all sites
    title: document.title,
    // Generate unique ID for this video instance
    videoId: uuidv4(),
  };

  // Format resolution string
  if (metadata.width && metadata.height) {
    const height = metadata.height;
    if (height >= 2160) {
      metadata.resolution = '4K';
    } else if (height >= 1440) {
      metadata.resolution = '1440p';
    } else if (height >= 1080) {
      metadata.resolution = '1080p';
    } else if (height >= 720) {
      metadata.resolution = '720p';
    } else if (height >= 480) {
      metadata.resolution = '480p';
    } else {
      metadata.resolution = `${height}p`;
    }
  }

  // Try to find a more specific title from the page context
  // Look for content near the video element
  if (!metadata.title || metadata.title.trim().length === 0 || 
      metadata.title.includes(' - ') || metadata.title.includes(' / ')) {
    // Generic approach: look for headings or text near the video
    let container = video.parentElement;
    let depth = 0;
    
    while (container && depth < 3) {
      // Look for headings (h1-h6) in the container
      const heading = container.querySelector('h1, h2, h3, h4, h5, h6');
      if (heading) {
        const headingText = heading.textContent?.trim();
        if (headingText && headingText.length > 0 && headingText.length < 200) {
          metadata.title = headingText;
          break;
        }
      }
      
      // Look for meta tags
      const ogTitle = document.querySelector('meta[property="og:title"]');
      if (ogTitle) {
        const ogTitleContent = (ogTitle as HTMLMetaElement).content?.trim();
        if (ogTitleContent && ogTitleContent.length > 0) {
          metadata.title = ogTitleContent;
          break;
        }
      }
      
      container = container.parentElement;
      depth++;
    }
    
    // Fallback to video's title attribute
    if (!metadata.title || metadata.title.trim().length === 0) {
      metadata.title = video.getAttribute('title') || document.title;
    }
  }

  // Extract thumbnail/preview
  metadata.thumbnail = await extractThumbnail(video, url);

  // Quality detection removed - only direct downloads supported

  return metadata;
}

/**
 * Extract thumbnail from video element or page
 */
async function extractThumbnail(video: HTMLVideoElement, url: string): Promise<string | undefined> {
  // Try to get thumbnail from video element's poster
  if (video.poster) {
    return video.poster;
  }

  // Try to get thumbnail from video poster attribute
  const poster = video.getAttribute('poster');
  if (poster) {
    return poster;
  }

  // Try to capture current frame as thumbnail
  try {
    if (video.readyState >= 2) { // HAVE_CURRENT_DATA
      const canvas = document.createElement('canvas');
      canvas.width = video.videoWidth || 320;
      canvas.height = video.videoHeight || 180;
      const ctx = canvas.getContext('2d');
      if (ctx) {
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        return canvas.toDataURL('image/jpeg', 0.8);
      }
    }
  } catch (error) {
    // CORS or other issues, ignore
  }

  // Try to find thumbnail in page (for YouTube, Twitter, etc.)
  const thumbnailSelectors = [
    'meta[property="og:image"]',
    'meta[name="twitter:image"]',
    'link[rel="image_src"]',
    'img[class*="thumbnail"]',
    'img[class*="preview"]',
  ];

  for (const selector of thumbnailSelectors) {
    const element = document.querySelector(selector);
    if (element) {
      const thumbnailUrl = element.getAttribute('content') || 
                          element.getAttribute('href') ||
                          (element as HTMLImageElement).src;
      if (thumbnailUrl) {
        return thumbnailUrl;
      }
    }
  }

  // Check for YouTube thumbnail pattern
  if (url.includes('youtube.com') || url.includes('youtu.be')) {
    const videoId = extractYouTubeVideoId(url);
    if (videoId) {
      return `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`;
    }
  }

  return undefined;
}

/**
 * Extract YouTube video ID from URL
 */
function extractYouTubeVideoId(url: string): string | null {
  const patterns = [
    /(?:youtube\.com\/watch\?v=|youtu\.be\/)([^&\n?#]+)/,
    /youtube\.com\/embed\/([^&\n?#]+)/,
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
 * Extract stable identifier from URL (works generically across sites)
 */
function extractStableId(url: string): string | null {
  // Look for common ID patterns in URLs (works across many sites)
  const patterns = [
    /\/(?:status|post|video|watch|id|p)\/([^\/?#]+)/,  // Twitter, Instagram, YouTube, etc.
    /[#&]video[=#]([^&?#]+)/,                         // Video ID in hash/query
    /\/embed\/([^\/?#]+)/,                            // Embed IDs
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
    existingIndex = detectedVideos.findIndex(v => v.videoId === video.videoId);
  }
  
  // Fallback: check by URL if no videoId match
  if (existingIndex < 0) {
    existingIndex = detectedVideos.findIndex(v => v.url === video.url);
  }
  
  // Fallback: check by stable ID pattern if URL contains one
  if (existingIndex < 0) {
    const videoId = extractStableId(video.url);
    if (videoId) {
      existingIndex = detectedVideos.findIndex(v => {
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
    if (video.title === document.title || 
        (!existing.title || existing.title.trim().length === 0)) {
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
    if (video.url !== existing.url && !video.url.startsWith('blob:') && !video.url.startsWith('data:')) {
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
    detectedVideos = detectedVideos.filter(v => v.pageUrl === currentUrl);
  }
}, 1000);

/**
 * Get video URL from video element
 * Tries multiple methods to extract the actual video file URL
 */
function getVideoUrl(video: HTMLVideoElement): string | null {
  // Check currentSrc (what's actually playing)
  if (video.currentSrc && !video.currentSrc.startsWith('blob:') && !video.currentSrc.startsWith('data:')) {
    return video.currentSrc;
  }

  // Check src attribute
  if (video.src && !video.src.startsWith('blob:') && !video.src.startsWith('data:')) {
    return video.src;
  }

  // Check all source elements (for multiple quality options)
  const sources = video.querySelectorAll('source');
  for (const sourceEl of Array.from(sources)) {
    const source = sourceEl as HTMLSourceElement;
    if (source.src && !source.src.startsWith('blob:') && !source.src.startsWith('data:')) {
      return source.src;
    }
  }

  return null;
}


/**
 * Listen for messages from popup and background script
 */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Check if extension context is still valid
  if (chrome.runtime.lastError) {
    const errorMessage = chrome.runtime.lastError.message || '';
    if (errorMessage.includes('Extension context invalidated')) {
      console.debug('Extension context invalidated');
      return false;
    }
    console.debug('Extension context error:', errorMessage);
    return false;
  }

  try {
    if (message.type === MessageType.GET_DETECTED_VIDEOS) {
      sendResponse({ videos: detectedVideos });
      return true; // Keep channel open for async response
    }
    
    
    return false;
  } catch (error) {
    console.debug('Error handling message:', error);
    return false;
  }
});

// Set up network interceptor IMMEDIATELY before DOM is ready
setupNetworkInterceptor();

// Initialize when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}

