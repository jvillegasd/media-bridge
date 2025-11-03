/**
 * Content script for video detection - sends detected videos to popup
 */

import { FormatDetector } from '../lib/downloader/format-detector';
import { MessageType } from '../shared/messages';
import { VideoMetadata } from '../lib/types';

// Video detection state
let detectedVideos: VideoMetadata[] = [];

/**
 * Initialize content script
 */
function init() {
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
    
    const videoUrl = getVideoUrl(vid);
    
    // Generate a stable identifier for this video
    let videoIdentifier: string;
    
    if (videoUrl && !videoUrl.startsWith('blob:') && !videoUrl.startsWith('data:')) {
      // Use the actual video URL if available and stable
      videoIdentifier = videoUrl;
    } else {
      // For blob/data URLs, generate a stable ID based on page context
      videoIdentifier = generateVideoId(vid, window.location.href);
    }
    
    // Skip if already detected
    if (detectedUrls.has(videoIdentifier)) {
      continue;
    }
    
    detectedUrls.add(videoIdentifier);
    
    // Extract metadata generically
    const metadata = await extractVideoMetadata(vid, videoIdentifier);
    if (metadata) {
      addDetectedVideo(metadata);
    }
  }

  // Detect video URLs in source elements
  const sourceElements = document.querySelectorAll('source[src*=".m3u8"], source[src*=".mpd"]');
  
  for (const source of Array.from(sourceElements)) {
    const url = (source as HTMLSourceElement).src;
    if (url && !detectedUrls.has(url)) {
      detectedUrls.add(url);
      const format = FormatDetector.detectFromUrl(url);
      const metadata: VideoMetadata = {
        url,
        format,
        pageUrl: window.location.href,
        title: document.title, // Default to browser tab title
      };
      addDetectedVideo(metadata);
    }
  }

  // Detect common video player patterns (site-specific fallbacks)
  await detectPlayerPatterns(detectedUrls);
}

/**
 * Extract video metadata from video element (generic approach)
 */
async function extractVideoMetadata(video: HTMLVideoElement, url: string): Promise<VideoMetadata | null> {
  const format = FormatDetector.detectFromUrl(url);
  
  const metadata: VideoMetadata = {
    url,
    format: format !== 'unknown' ? format : 'direct',
    pageUrl: window.location.href,
    width: video.videoWidth || undefined,
    height: video.videoHeight || undefined,
    duration: video.duration || undefined,
    // Default to browser tab title for all sites
    title: document.title,
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
  }).catch(() => {
    // Popup might not be open, ignore
  });
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
async function detectPlayerPatterns(detectedUrls: Set<string>) {
  // Twitter/X - detect first to ensure blob URLs get proper status URLs
  if (window.location.hostname.includes('twitter.com') || window.location.hostname.includes('x.com')) {
    await detectTwitterVideos(detectedUrls);
  }

  // YouTube
  if (window.location.hostname.includes('youtube.com') || window.location.hostname.includes('youtu.be')) {
    await detectYouTubeVideos(detectedUrls);
  }

  // Generic HLS.js/Dash.js players
  if ((window as any).Hls || (window as any).dashjs) {
    await detectMediaPlayerVideos(detectedUrls);
  }
}

/**
 * Detect YouTube videos
 */
async function detectYouTubeVideos(detectedUrls: Set<string>) {
  const pageUrl = window.location.href;
  
  // Check if this is a YouTube watch/embed page
  const videoId = extractYouTubeVideoId(pageUrl);
  if (!videoId) {
    return; // Not a video page
  }
  
  // Always add YouTube video based on URL, even if player data isn't loaded yet
  if (!detectedUrls.has(pageUrl)) {
    detectedUrls.add(pageUrl);
    
    // Try to get video info from YouTube's player response
    const ytPlayer = (window as any).ytInitialPlayerResponse || 
                    (window as any).ytplayer?.config?.args?.player_response;
    
    let metadata: VideoMetadata = {
      url: pageUrl,
      format: 'dash',
      pageUrl: window.location.href,
      thumbnail: `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`,
    };
    
    if (ytPlayer && ytPlayer.streamingData) {
      const videoDetails = ytPlayer.videoDetails;
      const formats = [
        ...(ytPlayer.streamingData.adaptiveFormats || []),
        ...(ytPlayer.streamingData.formats || []),
      ];
      
      // Find best quality video format
      const videoFormat = formats
        .filter((f: any) => f.mimeType?.includes('video'))
        .sort((a: any, b: any) => (b.width || 0) - (a.width || 0))[0];
      
      metadata.title = videoDetails?.title;
      metadata.duration = videoDetails?.lengthSeconds ? parseInt(videoDetails.lengthSeconds) : undefined;
      metadata.width = videoFormat?.width;
      metadata.height = videoFormat?.height;

      if (metadata.height) {
        if (metadata.height >= 2160) metadata.resolution = '4K';
        else if (metadata.height >= 1440) metadata.resolution = '1440p';
        else if (metadata.height >= 1080) metadata.resolution = '1080p';
        else if (metadata.height >= 720) metadata.resolution = '720p';
        else if (metadata.height >= 480) metadata.resolution = '480p';
        else metadata.resolution = `${metadata.height}p`;
      }
    } else {
      // Fallback: try to get title from page
      const titleElement = document.querySelector('h1.ytd-watch-metadata yt-formatted-string, h1.ytd-video-primary-info-renderer, meta[property="og:title"]');
      if (titleElement) {
        metadata.title = titleElement.textContent || 
                        (titleElement as HTMLMetaElement).content ||
                        document.title;
      } else {
        metadata.title = document.title;
      }
      
      // Try to get duration from page
      const durationElement = document.querySelector('span.ytp-time-duration');
      if (durationElement) {
        const durationText = durationElement.textContent || '';
        const match = durationText.match(/(\d+):(\d+)(?::(\d+))?/);
        if (match) {
          const hours = match[3] ? parseInt(match[1]) : 0;
          const minutes = match[3] ? parseInt(match[2]) : parseInt(match[1]);
          const seconds = match[3] ? parseInt(match[3]) : parseInt(match[2]);
          metadata.duration = hours * 3600 + minutes * 60 + seconds;
        }
      }
    }

    addDetectedVideo(metadata);
  }
}

/**
 * Detect Twitter/X videos (site-specific detection for blob URLs)
 */
async function detectTwitterVideos(detectedUrls: Set<string>) {
  // Twitter/X specific: Detect videos with blob URLs and give them proper status URLs
  // This runs proactively to catch videos that might not be detected generically
  const pageUrl = window.location.href;
  const videos = document.querySelectorAll('video');
  
  for (const video of Array.from(videos)) {
    const vid = video as HTMLVideoElement;
    
    // Skip very small videos (likely UI elements)
    if (vid.videoWidth > 0 && vid.videoHeight > 0 && 
        (vid.videoWidth < 50 || vid.videoHeight < 50)) {
      continue;
    }
    
    // Find container - try multiple selectors for robustness
    const container = vid.closest('article[data-testid="tweet"], article[role="article"], [data-testid*="tweet"]') ||
                     vid.closest('article');
    
    if (!container) {
      continue;
    }
    
    // Try to find tweet link for status ID - try multiple selectors
    const tweetLink = container.querySelector('a[href*="/status/"]') ||
                     container.querySelector('a[href*="/i/web/status/"]') ||
                     (container as HTMLElement).querySelector('a[href]');
    
    let tweetStatusId: string | null = null;
    let tweetUrl: string | null = null;
    
    if (tweetLink) {
      const href = tweetLink.getAttribute('href');
      if (href) {
        // Try multiple patterns for status ID
        const match = href.match(/\/status\/(\d+)/) || 
                     href.match(/\/i\/web\/status\/(\d+)/);
        if (match && match[1]) {
          tweetStatusId = match[1];
          tweetUrl = href.startsWith('http') ? href : `https://x.com${href}`;
        }
      }
    }
    
    // If we couldn't find status ID from link, try to extract from page URL if we're on a status page
    if (!tweetStatusId) {
      const pageStatusMatch = pageUrl.match(/\/status\/(\d+)/) ||
                            pageUrl.match(/\/i\/web\/status\/(\d+)/);
      if (pageStatusMatch && pageStatusMatch[1]) {
        tweetStatusId = pageStatusMatch[1];
        tweetUrl = pageUrl;
      }
    }
    
    // If we have a status ID, use it for the video URL
    const finalVideoUrl = tweetStatusId 
      ? `https://x.com/i/web/status/${tweetStatusId}`
      : generateVideoId(vid, pageUrl);
    
    // Check if already detected
    if (detectedUrls.has(finalVideoUrl)) {
      continue;
    }
    
    // Check if we already have a video with this status ID (if we have one)
    if (tweetStatusId) {
      const existingByStatusId = detectedVideos.findIndex(v => {
        const vId = extractStableId(v.url);
        return vId === tweetStatusId;
      });
      
      if (existingByStatusId >= 0) {
        // Update existing video with proper URL if needed
        const existing = detectedVideos[existingByStatusId];
        if (!existing.url.includes('/status/')) {
          existing.url = finalVideoUrl;
          existing.pageUrl = tweetUrl || pageUrl;
        }
        continue;
      }
    }
    
    // Check if already detected with generic ID
    const genericId = generateVideoId(vid, pageUrl);
    if (genericId !== finalVideoUrl) {
      const genericIndex = detectedVideos.findIndex(v => v.url === genericId);
      
      if (genericIndex >= 0) {
        // Update the generic detection with proper Twitter URL if we have a status ID
        if (tweetStatusId) {
          detectedVideos[genericIndex].url = finalVideoUrl;
          detectedVideos[genericIndex].pageUrl = tweetUrl || pageUrl;
        }
        continue;
      }
    }
    
    // Video wasn't detected yet, add it now
    detectedUrls.add(finalVideoUrl);
    
    const metadata = await extractVideoMetadata(vid, finalVideoUrl);
    if (metadata) {
      if (tweetStatusId) {
        metadata.url = finalVideoUrl;
        metadata.pageUrl = tweetUrl || pageUrl;
      }
      addDetectedVideo(metadata);
    }
  }
}

/**
 * Detect videos from HLS.js/Dash.js players
 */
async function detectMediaPlayerVideos(detectedUrls: Set<string>) {
  // Try to find video sources from player instances
  const videoElements = document.querySelectorAll('video');
  
  for (const video of Array.from(videoElements)) {
    const hls = (video as any).hls;
    if (hls && hls.url) {
      const url = hls.url;
      if (url && !detectedUrls.has(url)) {
        detectedUrls.add(url);
        const metadata = await extractVideoMetadata(video as HTMLVideoElement, url);
        if (metadata) {
          metadata.format = 'hls';
          addDetectedVideo(metadata);
        }
      }
    }

    const dash = (video as any).dash;
    if (dash && dash.getActiveStream) {
      const stream = dash.getActiveStream();
      if (stream && stream.url) {
        const url = stream.url;
        if (url && !detectedUrls.has(url)) {
          detectedUrls.add(url);
          const metadata = await extractVideoMetadata(video as HTMLVideoElement, url);
          if (metadata) {
            metadata.format = 'dash';
            addDetectedVideo(metadata);
          }
        }
      }
    }
  }
}

/**
 * Listen for messages from popup
 */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === MessageType.GET_DETECTED_VIDEOS) {
    sendResponse({ videos: detectedVideos });
  }
  return true;
});

// Initialize when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}

