/**
 * Content script for video detection - sends detected videos to popup
 */

import { FormatDetector } from '../lib/downloader/format-detector';
import { MessageType } from '../shared/messages';
import { VideoFormat, VideoMetadata, VideoQuality } from '../lib/types';
import { v4 as uuidv4 } from 'uuid';
import { M3U8Parser } from '../lib/parsers/m3u8-parser';

// Video detection state
let detectedVideos: VideoMetadata[] = [];
const capturedVideoUrls = new Map<HTMLVideoElement, string>(); // Map video element -> actual video URL

// Queue playlist URLs that are captured before a video element exists
interface PendingPlaylistCapture {
  url: string;
  timestamp: number;
}

const pendingPlaylistCaptures: PendingPlaylistCapture[] = [];
const PENDING_PLAYLIST_TTL_MS = 30_000;

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

function prunePendingPlaylistCaptures(now: number) {
  while (pendingPlaylistCaptures.length > 0) {
    const oldest = pendingPlaylistCaptures[0];
    if (now - oldest.timestamp > PENDING_PLAYLIST_TTL_MS) {
      pendingPlaylistCaptures.shift();
      continue;
    }
    break;
  }
}

function enqueuePendingPlaylist(url: string) {
  const now = Date.now();
  prunePendingPlaylistCaptures(now);

  if (pendingPlaylistCaptures.some((capture) => capture.url === url)) {
    return;
  }

  pendingPlaylistCaptures.push({ url, timestamp: now });
  console.log('[Media Bridge] Queued pending playlist capture:', url);
}

function consumePendingPlaylist(): string | null {
  const now = Date.now();
  prunePendingPlaylistCaptures(now);

  const capture = pendingPlaylistCaptures.shift();
  if (!capture) {
    return null;
  }

  console.log('[Media Bridge] Consumed pending playlist capture:', capture.url);
  return capture.url;
}

function removePendingPlaylist(url: string) {
  const index = pendingPlaylistCaptures.findIndex((capture) => capture.url === url);
  if (index >= 0) {
    pendingPlaylistCaptures.splice(index, 1);
  }
}

function normalizeFormat(format: VideoFormat): VideoFormat {
  if (format === 'unknown' || format === 'dash') {
    return 'direct';
  }
  return format;
}

function isDirectVideoUrl(url: string): boolean {
  return url.includes('.mp4') || url.includes('.webm') || url.includes('.mov') ||
                         url.includes('.avi') || url.includes('.mkv') || url.includes('.flv') ||
                         url.includes('.wmv') || url.includes('.ogg');
}

function isSegmentUrl(url: string): boolean {
  const lower = url.toLowerCase();
  if (lower.includes('.m4s')) {
    return true;
  }
  if (!lower.includes('.ts')) {
    return false;
  }
  return lower.includes('/seg-') || lower.includes('segment') || lower.includes('chunk');
}

function derivePlaylistCandidatesFromSegment(segmentUrl: string): string[] {
  const candidates = new Set<string>();

  try {
    const urlObj = new URL(segmentUrl);
    const search = urlObj.search ? urlObj.search : '';
    const pathname = urlObj.pathname;
    const lowerPath = pathname.toLowerCase();
    const pathParts = pathname.split('/');

    if (lowerPath.includes('.ts')) {
      const segmentIndex = pathParts.findIndex((part) => part.includes('seg-'));
      if (segmentIndex > 0) {
        const basePath = pathParts.slice(0, segmentIndex).join('/');
        if (basePath) {
          candidates.add(`${urlObj.origin}${basePath}/index.m3u8${search}`);
          candidates.add(`${urlObj.origin}${basePath}/master.m3u8${search}`);
          candidates.add(`${urlObj.origin}${basePath}/playlist.m3u8${search}`);
        }
      }
    }

  } catch (error) {
    console.debug('[Media Bridge] Failed to derive playlist from segment:', segmentUrl, error);
  }

  return Array.from(candidates);
}

function handlePlaylistCapture(url: string) {
  if (!registerCapturedUrl(url)) {
    return;
  }

  console.log('[Media Bridge] Captured HLS/DASH URL:', url);

        const videoElements = document.querySelectorAll('video');
  let storedToVideoElement = false;
        
        for (const video of Array.from(videoElements)) {
          const vid = video as HTMLVideoElement;
          const existing = capturedVideoUrls.get(vid);
          if (!existing || existing.startsWith('blob:') || existing.startsWith('data:') || 
        (!existing.includes('.m3u8') && !existing.includes('.mpd'))) {
            capturedVideoUrls.set(vid, url);
      storedToVideoElement = true;
      console.log('[Media Bridge] Stored playlist URL for video element:', url);
            }
          }
          
  if (storedToVideoElement) {
    removePendingPlaylist(url);
  } else {
    enqueuePendingPlaylist(url);
  }

  let updatedExistingVideo = false;
          for (const existingVideo of detectedVideos) {
            const needsUpdate = (!existingVideo.url.includes('.m3u8') && 
                               !existingVideo.url.includes('.mpd') && 
                               !existingVideo.url.includes('.mp4') &&
                               !existingVideo.url.includes('.webm') &&
                               !existingVideo.url.includes('.mov') &&
                               !existingVideo.url.includes('.avi') &&
                               !existingVideo.url.includes('.mkv')) &&
                               (existingVideo.pageUrl === window.location.href ||
                                (existingVideo.pageUrl && window.location.href.includes(existingVideo.pageUrl)));
          
          if (needsUpdate) {
            existingVideo.url = url;
            const interceptedFormat = url.includes('.m3u8')
              ? 'hls'
              : (url.includes('.mpd') ? 'direct' : existingVideo.format);
            existingVideo.format = normalizeFormat(interceptedFormat as VideoFormat);
            updatedExistingVideo = true;
      removePendingPlaylist(url);
            
            try {
              chrome.runtime.sendMessage({
                type: MessageType.VIDEO_DETECTED,
                payload: existingVideo,
              }).catch(() => {
                // Popup might not be open, ignore
              });
            } catch (e) {
              // Ignore errors
            }
                break;
          }
        }
            
  if (!updatedExistingVideo) {
    const delay = videoElements.length > 0 ? 100 : 500;
    setTimeout(() => detectVideos(), delay);
  }
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
          const needsUpdate = (!existingVideo.url.includes('.m3u8') && 
                                 !existingVideo.url.includes('.mpd') && 
                                 !existingVideo.url.includes('.mp4') &&
                                 !existingVideo.url.includes('.webm') &&
                             !existingVideo.url.includes('.mov') &&
                             !existingVideo.url.includes('.avi') &&
                             !existingVideo.url.includes('.mkv')) &&
                                 (existingVideo.pageUrl === window.location.href ||
                                  (existingVideo.pageUrl && window.location.href.includes(existingVideo.pageUrl)));
              
              if (needsUpdate) {
      existingVideo.url = url;
      existingVideo.format = normalizeFormat('direct');
          updatedExistingVideo = true;
                
                try {
                  chrome.runtime.sendMessage({
                    type: MessageType.VIDEO_DETECTED,
                    payload: existingVideo,
                  }).catch(() => {
                    // Popup might not be open, ignore
                  });
                } catch (e) {
                  // Ignore errors
                }
                break;
              }
            }
            
  if (!updatedExistingVideo) {
    const delay = videoElements.length > 0 ? 100 : 500;
    setTimeout(() => detectVideos(), delay);
            }
          }

function handleSegmentCapture(url: string) {
  if (!registerCapturedUrl(url)) {
    return;
  }

  const candidates = derivePlaylistCandidatesFromSegment(url);
  if (candidates.length === 0) {
    return;
  }

  console.log('[Media Bridge] Detected segment URL, attempting to derive playlists:', {
    segment: url,
    candidates,
  });

  for (const candidate of candidates) {
    handlePlaylistCapture(candidate);
  }
}

function handleCapturedRequest(url: string) {
  const lowerUrl = url.toLowerCase();

  if (lowerUrl.includes('.m3u8') || lowerUrl.includes('.mpd')) {
    handlePlaylistCapture(url);
  }

  if (isDirectVideoUrl(lowerUrl)) {
    handleDirectCapture(url);
  }

  if (isSegmentUrl(lowerUrl)) {
    handleSegmentCapture(url);
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
        if (
          lower.includes('.m3u8') ||
          lower.includes('.mpd') ||
          lower.includes('.m4s') ||
          lower.includes('.ts') ||
          isDirectVideoUrl(lower)
        ) {
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
  // Increased interval for Twitter/X since scrolling loads content
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
    
    // Prioritize HLS/DASH over direct video links
    let videoUrl: string | null = null;
    let directVideoUrl: string | null = null; // Fallback for direct videos
    
    // First, always check for HLS/DASH sources (prioritize these)
    // Check captured URLs for HLS/DASH
    let capturedUrl = capturedVideoUrls.get(vid);
    if (!capturedUrl) {
      const pendingPlaylist = consumePendingPlaylist();
      if (pendingPlaylist) {
        capturedVideoUrls.set(vid, pendingPlaylist);
        capturedUrl = pendingPlaylist;
        console.log('[Media Bridge] Assigned pending playlist URL to video element:', pendingPlaylist);
      }
    }

    if (capturedUrl) {
      console.log('[Media Bridge] Found captured URL for video element:', capturedUrl);
      if (capturedUrl.includes('.m3u8') || capturedUrl.includes('.mpd')) {
        videoUrl = capturedUrl;
        console.log('[Media Bridge] Using HLS/DASH captured URL:', videoUrl);
      } else {
        // Store direct video URL as fallback
        directVideoUrl = capturedUrl;
        console.log('[Media Bridge] Using direct captured URL as fallback:', directVideoUrl);
      }
    }
    
    // Check HLS.js player
    if (!videoUrl) {
      const hls = (vid as any).hls;
      if (hls) {
        if (hls.url && typeof hls.url === 'string' && !hls.url.startsWith('blob:') && !hls.url.startsWith('data:')) {
          videoUrl = hls.url;
        } else if (hls.media && hls.media.src && !hls.media.src.startsWith('blob:') && !hls.media.src.startsWith('data:')) {
          videoUrl = hls.media.src;
        } else if (hls.levels && hls.levels.length > 0) {
          for (const level of hls.levels) {
            if (level && level.url && !level.url.startsWith('blob:') && !level.url.startsWith('data:')) {
              videoUrl = level.url;
              break;
            }
          }
        }
      }
    }
    
    // Check Dash.js player
    if (!videoUrl) {
      const dash = (vid as any).dash;
      if (dash) {
        if (dash.getSource && dash.getSource()) {
          const source = dash.getSource();
          if (source && source.url && !source.url.startsWith('blob:')) {
            videoUrl = source.url;
          }
        } else if (dash.getActiveStream) {
          const stream = dash.getActiveStream();
          if (stream && stream.url && !stream.url.startsWith('blob:')) {
            videoUrl = stream.url;
          }
        }
      }
    }
    
    // Check source elements for HLS/DASH
    if (!videoUrl) {
      const sources = vid.querySelectorAll('source');
      for (const sourceEl of Array.from(sources)) {
        const source = sourceEl as HTMLSourceElement;
        if (source.src && (source.src.includes('.m3u8') || source.src.includes('.mpd'))) {
          videoUrl = source.src;
          break;
        }
      }
    }
    
    // Fallback to direct video links if no HLS/DASH found
    if (!videoUrl) {
      // Use getVideoUrl() which already checks HLS/DASH first, then falls back to direct
      const fallbackUrl = getVideoUrl(vid);
      if (fallbackUrl) {
        // If getVideoUrl returns HLS/DASH, use it (it prioritizes correctly)
        if (fallbackUrl.includes('.m3u8') || fallbackUrl.includes('.mpd')) {
          videoUrl = fallbackUrl;
        } else {
          // It's a direct video, use it as fallback
          directVideoUrl = fallbackUrl;
          videoUrl = directVideoUrl;
        }
      } else if (directVideoUrl) {
        // Use captured direct video URL if available
        videoUrl = directVideoUrl;
      }
    }
    
    const isRealUrl = videoUrl && !videoUrl.startsWith('blob:') && !videoUrl.startsWith('data:');
    
    // If we don't have a real URL for a direct video, skip it (can't download page URLs)
    // Only allow videos without real URLs if they're HLS/DASH (which will be handled differently)
    if (!isRealUrl && !videoUrl) {
      console.log('[Media Bridge] Skipping video - no real URL found and not HLS/DASH');
      continue;
    }
    
    // For blob URLs, check if we have any captured video URL (HLS/DASH or direct), otherwise skip
    if (!isRealUrl && videoUrl && videoUrl.startsWith('blob:')) {
      // If we have any captured video URL (HLS/DASH or direct video file), use that instead of blob URL
      const captured = capturedVideoUrls.get(vid);
      if (captured && (
        captured.includes('.m3u8') || 
        captured.includes('.mpd') || 
        captured.includes('.mp4') || 
        captured.includes('.webm') || 
        captured.includes('.mov') ||
        captured.includes('.avi') ||
        captured.includes('.mkv')
      )) {
        videoUrl = captured;
        console.log('[Media Bridge] Using captured video URL instead of blob URL:', videoUrl);
        // Now it's a real URL
        // isRealUrl will be updated below, but we need to use videoUrl which is now the captured URL
      } else {
        console.log('[Media Bridge] Skipping video - only blob URL found and no video URL captured');
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
    
    console.log('[Media Bridge] Detected video:', {
      url: finalUrl,
      format: finalFormat,
      isHLSorDASH: finalFormat === 'hls' || finalFormat === 'dash',
      pageUrl: metadata.pageUrl
    });

    // Check if there's an existing direct video from the same page that should be replaced with HLS/DASH
    const isHLSorDASH = finalFormat === 'hls' || finalFormat === 'dash';
    if (isHLSorDASH && metadata.pageUrl) {
      // Look for existing direct video from the same page that could be the same video
      // Try to match by pageUrl and similar dimensions/duration first (more likely same video)
      let existingDirectVideoIndex = -1;
      
      // First try: Match by pageUrl, format, and similar dimensions (most accurate)
      if (metadata.width && metadata.height) {
        existingDirectVideoIndex = detectedVideos.findIndex(v => 
          v.pageUrl === metadata.pageUrl && 
          v.format === 'direct' &&
          v.width === metadata.width &&
          v.height === metadata.height &&
          (v.url.includes('.mp4') || v.url.includes('.webm') || v.url.includes('.mov'))
        );
      }
      
      // Second try: Match by pageUrl and format only (if dimensions don't match or aren't available)
      if (existingDirectVideoIndex < 0) {
        existingDirectVideoIndex = detectedVideos.findIndex(v => 
          v.pageUrl === metadata.pageUrl && 
          v.format === 'direct' &&
          (v.url.includes('.mp4') || v.url.includes('.webm') || v.url.includes('.mov')) &&
          // Only replace if there's only one direct video on this page (to avoid false matches)
          detectedVideos.filter(dv => dv.pageUrl === metadata.pageUrl && dv.format === 'direct').length === 1
        );
      }
      
      if (existingDirectVideoIndex >= 0) {
        // Replace the direct video with HLS/DASH
        const existingDirect = detectedVideos[existingDirectVideoIndex];
        // Preserve metadata from existing video
        metadata.title = metadata.title || existingDirect.title;
        metadata.thumbnail = metadata.thumbnail || existingDirect.thumbnail;
        metadata.width = metadata.width || existingDirect.width;
        metadata.height = metadata.height || existingDirect.height;
        metadata.duration = metadata.duration || existingDirect.duration;
        metadata.resolution = metadata.resolution || existingDirect.resolution;
        metadata.videoId = existingDirect.videoId || metadata.videoId; // Keep the same videoId
        
        // Remove the direct video
        detectedVideos.splice(existingDirectVideoIndex, 1);
        detectedUrls.delete(existingDirect.url);
        
        // Add the HLS/DASH video
        detectedUrls.add(videoIdentifier);
        detectedUrls.add(finalUrl);
        addDetectedVideo(metadata);
        
        // Already added, skip the normal add at the end
        continue;
      }
    }

    // Track both identifier and final URL to avoid duplicates in subsequent runs
    detectedUrls.add(videoIdentifier);
    detectedUrls.add(finalUrl);

    addDetectedVideo(metadata);
  }

  // Detect video URLs in source elements (HLS only for now)
  const sourceElements = document.querySelectorAll('source[src*=".m3u8"]');
  
  for (const source of Array.from(sourceElements)) {
    const url = (source as HTMLSourceElement).src;
    if (url && !detectedUrls.has(url)) {
      detectedUrls.add(url);
      const format = normalizeFormat(FormatDetector.detectFromUrl(url));
      const metadata: VideoMetadata = {
        url,
        format,
        pageUrl: window.location.href,
        title: document.title, // Default to browser tab title
      };
      addDetectedVideo(metadata);
    }
  }

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

  // Extract available qualities for all adaptive streaming formats
  // HLS streams
  if (normalizedFormat === 'hls' || url.includes('.m3u8')) {
    try {
      // Check HLS.js player for levels
      const hls = (video as any).hls;
      if (hls && hls.levels && hls.levels.length > 0) {
        const qualities: VideoQuality[] = hls.levels.map((level: any, index: number) => {
          const resolution = level.resolution || level.attrs?.RESOLUTION;
          const bandwidth = level.bitrate || level.attrs?.BANDWIDTH || 0;
          const width = level.width || (resolution ? parseInt(resolution.split('x')[0]) : undefined);
          const height = level.height || (resolution ? parseInt(resolution.split('x')[1]) : undefined);
          
          // Generate human-readable quality label
          let qualityLabel: string | undefined;
          if (height) {
            if (height >= 2160) qualityLabel = '4K';
            else if (height >= 1440) qualityLabel = '1440p';
            else if (height >= 1080) qualityLabel = '1080p';
            else if (height >= 720) qualityLabel = '720p';
            else if (height >= 480) qualityLabel = '480p';
            else if (height >= 360) qualityLabel = '360p';
            else qualityLabel = `${height}p`;
          } else if (bandwidth) {
            // Fallback to bitrate-based label
            if (bandwidth >= 8000000) qualityLabel = '4K';
            else if (bandwidth >= 5000000) qualityLabel = '1080p';
            else if (bandwidth >= 2500000) qualityLabel = '720p';
            else if (bandwidth >= 1000000) qualityLabel = '480p';
            else qualityLabel = '360p';
          }
          
          return {
            url: level.url || url,
            bandwidth: bandwidth,
            resolution: resolution,
            width: width,
            height: height,
            quality: qualityLabel,
            codecs: level.attrs?.CODECS,
          };
        }).filter((q: VideoQuality) => q.url); // Only include qualities with URLs
        
        if (qualities.length > 0) {
          metadata.availableQualities = qualities;
          // Set current quality based on selected level
          const currentLevel = hls.currentLevel;
          if (currentLevel !== -1 && qualities[currentLevel]) {
            metadata.quality = qualities[currentLevel].quality;
            metadata.resolution = qualities[currentLevel].resolution;
          } else if (qualities.length > 0) {
            // Default to highest quality
            const highestQuality = qualities.sort((a, b) => (b.bandwidth || 0) - (a.bandwidth || 0))[0];
            metadata.quality = highestQuality.quality;
            metadata.resolution = highestQuality.resolution;
          }
        }
      } else if (url.includes('.m3u8')) {
        // Try to fetch and parse the playlist to get variants
        try {
          const response = await fetch(url);
          const playlistText = await response.text();
          const playlist = M3U8Parser.parse(playlistText, url);
          
          if (playlist.isMasterPlaylist && playlist.variants && playlist.variants.length > 0) {
            const qualities: VideoQuality[] = playlist.variants.map(variant => {
              const resolution = variant.resolution;
              const width = resolution ? parseInt(resolution.split('x')[0]) : undefined;
              const height = resolution ? parseInt(resolution.split('x')[1]) : undefined;
              
              let qualityLabel: string | undefined;
              if (height) {
                if (height >= 2160) qualityLabel = '4K';
                else if (height >= 1440) qualityLabel = '1440p';
                else if (height >= 1080) qualityLabel = '1080p';
                else if (height >= 720) qualityLabel = '720p';
                else if (height >= 480) qualityLabel = '480p';
                else if (height >= 360) qualityLabel = '360p';
                else qualityLabel = `${height}p`;
              } else if (variant.bandwidth) {
                if (variant.bandwidth >= 8000000) qualityLabel = '4K';
                else if (variant.bandwidth >= 5000000) qualityLabel = '1080p';
                else if (variant.bandwidth >= 2500000) qualityLabel = '720p';
                else if (variant.bandwidth >= 1000000) qualityLabel = '480p';
                else qualityLabel = '360p';
              }
              
              return {
                url: variant.url,
                bandwidth: variant.bandwidth,
                resolution: variant.resolution,
                width: width,
                height: height,
                quality: qualityLabel,
                codecs: variant.codecs,
              };
            });
            
            metadata.availableQualities = qualities;
            // Set highest quality as default
            if (qualities.length > 0) {
              const highestQuality = qualities.sort((a, b) => b.bandwidth - a.bandwidth)[0];
              metadata.quality = highestQuality.quality;
              metadata.resolution = highestQuality.resolution;
            }
          }
        } catch (error) {
          // Failed to fetch/parse playlist, continue without quality info
          console.debug('Failed to fetch HLS playlist for quality detection:', error);
        }
      }
    } catch (error) {
      // Failed to extract qualities, continue without them
      console.debug('Failed to extract video qualities:', error);
    }
  }
  
  // Direct videos - check for multiple source elements with different qualities
  if (normalizedFormat === 'direct') {
    try {
      const sources = video.querySelectorAll('source');
      if (sources.length > 1) {
        const qualities: VideoQuality[] = [];
        for (const sourceEl of Array.from(sources)) {
          const source = sourceEl as HTMLSourceElement;
          if (source.src && !source.src.startsWith('blob:') && !source.src.startsWith('data:')) {
            // Try to extract quality from srcset, type, or media attributes
            const type = source.type;
            const media = source.media;
            let qualityLabel: string | undefined;
            let width: number | undefined;
            let height: number | undefined;
            
            // Check media query for resolution (e.g., "min-width: 1920px")
            if (media) {
              const widthMatch = media.match(/width:\s*(\d+)px/);
              const heightMatch = media.match(/height:\s*(\d+)px/);
              if (widthMatch) width = parseInt(widthMatch[1]);
              if (heightMatch) height = parseInt(heightMatch[1]);
            }
            
            // Check if source element has dimensions from data attributes or class names
            if (!width && !height) {
              const dataWidth = source.getAttribute('data-width');
              const dataHeight = source.getAttribute('data-height');
              if (dataWidth) width = parseInt(dataWidth);
              if (dataHeight) height = parseInt(dataHeight);
            }
            
            if (height) {
              if (height >= 2160) qualityLabel = '4K';
              else if (height >= 1440) qualityLabel = '1440p';
              else if (height >= 1080) qualityLabel = '1080p';
              else if (height >= 720) qualityLabel = '720p';
              else if (height >= 480) qualityLabel = '480p';
              else if (height >= 360) qualityLabel = '360p';
              else qualityLabel = `${height}p`;
            }
            
            if (qualityLabel || source.src !== metadata.url) {
              qualities.push({
                url: source.src,
                bandwidth: 0, // Unknown for direct videos
                resolution: width && height ? `${width}x${height}` : undefined,
                width: width,
                height: height,
                quality: qualityLabel || 'Auto',
                codecs: type ? type.split(';')[0] : undefined,
              });
            }
          }
        }
        
        if (qualities.length > 1) {
          metadata.availableQualities = qualities;
        }
      }
    } catch (error) {
      console.debug('Failed to extract direct video qualities:', error);
    }
  }

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
  // Check if already exists by URL
  let existingIndex = detectedVideos.findIndex(v => v.url === video.url);
  
  // If not found and URL contains an ID pattern, check by ID
  if (existingIndex < 0) {
    const videoId = extractStableId(video.url);
    if (videoId) {
      existingIndex = detectedVideos.findIndex(v => {
        const vId = extractStableId(v.url);
        return vId && vId === videoId && v.pageUrl === video.pageUrl;
      });
    }
  }
  
  if (existingIndex >= 0) {
    // Update existing entry
    const existing = detectedVideos[existingIndex];
    
    // Update title - prefer browser tab title (document.title) over any other title
    // Browser tab title is more reliable and consistent
    if (video.title === document.title || 
        (!existing.title || existing.title.trim().length === 0)) {
      existing.title = video.title || document.title;
    }
    
    // Update other metadata if missing
    if (!existing.thumbnail && video.thumbnail) {
      existing.thumbnail = video.thumbnail;
    }
    if (!existing.width && video.width) {
      existing.width = video.width;
    }
    if (!existing.height && video.height) {
      existing.height = video.height;
    }
    if (!existing.duration && video.duration) {
      existing.duration = video.duration;
    }
    if (!existing.resolution && video.resolution) {
      existing.resolution = video.resolution;
    }
    // Don't send duplicate message
    return;
  }

  detectedVideos.push(video);
  
  // Send to popup
  chrome.runtime.sendMessage({
    type: MessageType.VIDEO_DETECTED,
    payload: video,
  }).catch((error) => {
    // Popup might not be open, or extension context invalidated
    // Check if error is due to invalidated context
    if (error?.message?.includes('Extension context invalidated') || 
        chrome.runtime.lastError?.message?.includes('Extension context invalidated')) {
      // Extension was reloaded, stop trying to send messages
      console.debug('Extension context invalidated, stopping video detection notifications');
      return;
    }
    // Other errors (popup not open, etc.) - ignore silently
  });
}

/**
 * Get video URL from video element
 * Tries multiple methods to extract the actual video file URL
 */
function getVideoUrl(video: HTMLVideoElement): string | null {
  // Check for HLS.js player first (most reliable for HLS streams)
  const hls = (video as any).hls;
  if (hls) {
    // HLS.js stores the manifest URL in hls.url
    if (hls.url && typeof hls.url === 'string' && !hls.url.startsWith('blob:') && !hls.url.startsWith('data:')) {
      return hls.url;
    }
    
    // Also check hls.media if url is not directly available
    if (hls.media && hls.media.src && !hls.media.src.startsWith('blob:') && !hls.media.src.startsWith('data:')) {
      return hls.media.src;
    }
    
    // Check for master playlist in hls levels
    if (hls.levels && hls.levels.length > 0) {
      for (const level of hls.levels) {
        if (level && level.url && !level.url.startsWith('blob:') && !level.url.startsWith('data:')) {
          return level.url;
        }
      }
    }
    
    // Check captured URLs from network interceptor
    const captured = capturedVideoUrls.get(video);
    if (captured && (captured.includes('.m3u8') || captured.includes('.mpd'))) {
      return captured;
    }
  }

  // Check for Dash.js player
  const dash = (video as any).dash;
  if (dash) {
    if (dash.getProtectionController && dash.getProtectionController().getLicenseServer) {
      // Dash.js has the manifest URL
      const player = dash;
      if (player.getSource && player.getSource()) {
        const source = player.getSource();
        if (source && source.url && !source.url.startsWith('blob:')) {
          return source.url;
        }
      }
    }
    
    if (dash.getActiveStream) {
      const stream = dash.getActiveStream();
      if (stream && stream.url && !stream.url.startsWith('blob:')) {
        return stream.url;
      }
    }
  }

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
 * Listen for messages from popup
 */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Check if extension context is still valid
  if (chrome.runtime.lastError) {
    console.debug('Extension context error:', chrome.runtime.lastError.message);
    return false;
  }
  
  try {
    if (message.type === MessageType.GET_DETECTED_VIDEOS) {
      sendResponse({ videos: detectedVideos });
    }
    return true;
  } catch (error) {
    console.debug('Error handling message:', error);
    return false;
  }
});

// Set up network interceptor IMMEDIATELY before DOM is ready
// This ensures we capture early HLS/DASH requests that happen before init()
setupNetworkInterceptor();

// Initialize when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}

