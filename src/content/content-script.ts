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

function normalizeFormat(format: VideoFormat): VideoFormat {
  if (format === 'unknown' || format === 'dash') {
    return 'direct';
  }
  return format;
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
      // Capture .m3u8 and .mpd URLs (HLS/DASH playlists) and .ts segments (to derive master playlist)
      if (url.includes('.m3u8') || url.includes('.mpd')) {
        // Try to find which video element this belongs to by checking HLS.js players
        const videoElements = document.querySelectorAll('video');
        let updatedExistingVideo = false;
        
        for (const video of Array.from(videoElements)) {
          const vid = video as HTMLVideoElement;
          const hls = (vid as any).hls;
          
          // Store the URL for this video element
          capturedVideoUrls.set(vid, url);
          
          // If this URL matches the HLS player or is a playlist URL, store it
          if (hls) {
            const hlsUrl = hls.url;
            // Check if this is the master playlist or matches the player's URL pattern
            if (url.includes('.m3u8') && (hlsUrl === url || url.includes(hlsUrl?.split('/').slice(0, -1).join('/') || '') || !hlsUrl)) {
              // Already stored above
            }
          }
        }
        
        // Update existing detected videos - try multiple matching strategies
        for (const existingVideo of detectedVideos) {
          // Check if this video needs updating (has page URL but not actual video URL)
          const needsUpdate = !existingVideo.url.includes('.m3u8') && 
                             !existingVideo.url.includes('.mpd') && 
                             !existingVideo.url.includes('.mp4') &&
                             !existingVideo.url.includes('.webm') &&
                             (existingVideo.pageUrl === window.location.href ||
                              (existingVideo.pageUrl && window.location.href.includes(existingVideo.pageUrl)));
          
          if (needsUpdate) {
            existingVideo.url = url;
            const interceptedFormat = url.includes('.m3u8')
              ? 'hls'
              : (url.includes('.mpd') ? 'direct' : existingVideo.format);
            existingVideo.format = normalizeFormat(interceptedFormat as VideoFormat);
            updatedExistingVideo = true;
            
            // Notify popup of the update
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
            break; // Update only the first matching video
          }
        }
        
        // If no existing video was updated and we have video elements, create new detection
        if (!updatedExistingVideo && videoElements.length > 0) {
          // This will be handled by regular detection, but we can trigger it
          setTimeout(() => detectVideos(), 100);
        }
      } else if (url.includes('/seg-') && url.includes('.ts')) {
        // This is an HLS segment - try to derive the master playlist URL
        // Example: .../1080P_4000K_26757925.mp4/seg-18-v1-a1.ts -> .../1080P_4000K_26757925.mp4/index.m3u8
        try {
          const urlObj = new URL(url);
          const pathParts = urlObj.pathname.split('/');
          // Find the directory containing the segments (usually ends with .mp4 or quality name)
          const segmentIndex = pathParts.findIndex(part => part.includes('seg-'));
          if (segmentIndex > 0) {
            // Get the path up to the segment
            const basePath = pathParts.slice(0, segmentIndex).join('/');
            // Try common master playlist names
            const masterPlaylistUrl = `${urlObj.origin}${basePath}/index.m3u8${urlObj.search ? urlObj.search : ''}`;
            
            // Store the master playlist URL for video elements
            const videoElements = document.querySelectorAll('video');
            for (const video of Array.from(videoElements)) {
              const vid = video as HTMLVideoElement;
              capturedVideoUrls.set(vid, masterPlaylistUrl);
            }
            
            // Update existing detected videos with the master playlist URL
            let segmentUpdatedVideo = false;
            for (const existingVideo of detectedVideos) {
              const needsUpdate = !existingVideo.url.includes('.m3u8') && 
                                 !existingVideo.url.includes('.mpd') && 
                                 !existingVideo.url.includes('.mp4') &&
                                 !existingVideo.url.includes('.webm') &&
                                 (existingVideo.pageUrl === window.location.href ||
                                  (existingVideo.pageUrl && window.location.href.includes(existingVideo.pageUrl)));
              
              if (needsUpdate) {
                existingVideo.url = masterPlaylistUrl;
                existingVideo.format = 'hls';
                segmentUpdatedVideo = true;
                
                // Notify popup of the update
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
            
            // If no existing video was updated but we have video elements, trigger detection
            if (!segmentUpdatedVideo && videoElements.length > 0) {
              setTimeout(() => detectVideos(), 100);
            }
          }
        } catch (e) {
          // URL parsing failed, ignore
        }
      }
    }
    return originalFetch.call(this, input, init);
  };

  // Also intercept XMLHttpRequest
  const originalXHROpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function(method: string, url: string | URL, async?: boolean, username?: string | null, password?: string | null) {
    const urlString = typeof url === 'string' ? url : url.toString();
    if (urlString.includes('.m3u8') || urlString.includes('.mpd')) {
      // Store captured URL
      const videoElements = document.querySelectorAll('video');
      for (const video of Array.from(videoElements)) {
        const vid = video as HTMLVideoElement;
        capturedVideoUrls.set(vid, urlString);
      }
      
      // Also update existing detected videos (same logic as fetch interceptor)
      for (const existingVideo of detectedVideos) {
        const needsUpdate = !existingVideo.url.includes('.m3u8') && 
                           !existingVideo.url.includes('.mpd') && 
                           !existingVideo.url.includes('.mp4') &&
                           !existingVideo.url.includes('.webm') &&
                           (existingVideo.pageUrl === window.location.href ||
                            (existingVideo.pageUrl && window.location.href.includes(existingVideo.pageUrl)));
        
        if (needsUpdate) {
          existingVideo.url = urlString;
          const interceptedFormat = urlString.includes('.m3u8')
            ? 'hls'
            : (urlString.includes('.mpd') ? 'direct' : existingVideo.format);
          existingVideo.format = normalizeFormat(interceptedFormat as VideoFormat);
          
          // Notify popup of the update
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
    } else if (urlString.includes('/seg-') && urlString.includes('.ts')) {
      // HLS segment - derive master playlist
      try {
        const urlObj = new URL(urlString);
        const pathParts = urlObj.pathname.split('/');
        const segmentIndex = pathParts.findIndex(part => part.includes('seg-'));
        if (segmentIndex > 0) {
          const basePath = pathParts.slice(0, segmentIndex).join('/');
          const masterPlaylistUrl = `${urlObj.origin}${basePath}/index.m3u8${urlObj.search ? urlObj.search : ''}`;
          const videoElements = document.querySelectorAll('video');
          
          for (const video of Array.from(videoElements)) {
            const vid = video as HTMLVideoElement;
            capturedVideoUrls.set(vid, masterPlaylistUrl);
          }
          
          // Update existing detected videos with the master playlist URL
          for (const existingVideo of detectedVideos) {
            const needsUpdate = !existingVideo.url.includes('.m3u8') && 
                               !existingVideo.url.includes('.mpd') && 
                               !existingVideo.url.includes('.mp4') &&
                               !existingVideo.url.includes('.webm') &&
                               (existingVideo.pageUrl === window.location.href ||
                                (existingVideo.pageUrl && window.location.href.includes(existingVideo.pageUrl)));
            
            if (needsUpdate) {
              existingVideo.url = masterPlaylistUrl;
              existingVideo.format = 'hls';
              
              // Notify popup of the update
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
        }
      } catch (e) {
        // Ignore
      }
    }
    return originalXHROpen.call(this, method, url, async !== undefined ? async : true, username, password);
  };
}

/**
 * Initialize content script
 */
function init() {
  // Setup network interception to capture actual video URLs
  setupNetworkInterceptor();
  
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
    
    let videoUrl = getVideoUrl(vid);
    
    // Check if we captured a real URL from network requests
    if (!videoUrl || videoUrl.startsWith('blob:') || videoUrl.startsWith('data:')) {
      const capturedUrl = capturedVideoUrls.get(vid);
      if (capturedUrl && (capturedUrl.includes('.m3u8') || capturedUrl.includes('.mpd') || capturedUrl.includes('.mp4'))) {
        videoUrl = capturedUrl;
      }
    }
    
    const isRealUrl = videoUrl && !videoUrl.startsWith('blob:') && !videoUrl.startsWith('data:');
    const videoIdentifier = isRealUrl
      ? (videoUrl as string)
      : generateVideoId(vid, window.location.href);

    if (detectedUrls.has(videoIdentifier)) {
      continue;
    }

    const metadata = await extractVideoMetadata(vid, isRealUrl ? (videoUrl as string) : videoIdentifier);
    if (!metadata) {
      continue;
    }

    let finalUrl = metadata.url;
    if (isRealUrl) {
      finalUrl = videoUrl as string;
    }

    const finalFormat = normalizeFormat(FormatDetector.detectFromUrl(finalUrl));
    metadata.url = finalUrl;
    metadata.format = finalFormat;

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

// Initialize when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}

