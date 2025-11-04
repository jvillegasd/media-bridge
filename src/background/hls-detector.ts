/**
 * HLS detector - detects HLS playlists via webRequest API
 */

import { logger } from '../core/utils/logger';

interface DetectedPlaylist {
  url: string;
  tabId: number;
  pageUrl?: string;
  pageTitle?: string;
  detectedAt: number;
}

// Store detected playlists
const detectedPlaylists = new Map<string, DetectedPlaylist>();

/**
 * Initialize HLS playlist detection
 */
export function initializeHlsDetector(): void {
  if (!chrome.webRequest) {
    logger.warn('webRequest API not available');
    return;
  }

  // Listen for completed requests
  chrome.webRequest.onCompleted.addListener(
    async (details) => {
      // Only process requests from tabs (not background requests)
      if (details.tabId < 0) {
        return;
      }

      // Check content-type header
      const contentTypeHeader = details.responseHeaders?.find(
        (h) => h.name.toLowerCase() === 'content-type'
      );

      const contentType = contentTypeHeader?.value?.toLowerCase() || '';

      // Check if it's an HLS playlist
      if (
        !contentType.includes('application/vnd.apple.mpegurl') &&
        !contentType.includes('application/x-mpegurl') &&
        !details.url.includes('.m3u8')
      ) {
        return;
      }

      // Check status code
      if (details.statusCode && (details.statusCode < 200 || details.statusCode >= 300)) {
        return;
      }

      // Check if we've already detected this playlist
      if (detectedPlaylists.has(details.url)) {
        return;
      }

      // Get tab information
      let pageUrl: string | undefined;
      let pageTitle: string | undefined;

      try {
        const tab = await chrome.tabs.get(details.tabId);
        pageUrl = tab.url;
        pageTitle = tab.title;
      } catch (error) {
        logger.debug('Could not get tab info:', error);
      }

      // Store detected playlist
      detectedPlaylists.set(details.url, {
        url: details.url,
        tabId: details.tabId,
        pageUrl,
        pageTitle,
        detectedAt: Date.now(),
      });

      logger.info(`Detected HLS playlist: ${details.url}`);
      
      // Send message to content script to handle the playlist
      try {
        await chrome.tabs.sendMessage(details.tabId, {
          type: 'HLS_PLAYLIST_DETECTED',
          payload: {
            url: details.url,
            pageUrl,
            pageTitle,
          },
        });
      } catch (error) {
        // Content script might not be loaded yet, or tab might not have content script
        // This is okay - the content script will also detect via network interception
        logger.debug('Could not send playlist to content script:', error);
      }
    },
    {
      urls: ['http://*/*', 'https://*/*'],
      types: ['xmlhttprequest', 'main_frame', 'sub_frame'],
    },
    ['responseHeaders']
  );
}

/**
 * Get detected playlists for a tab
 */
export function getDetectedPlaylists(tabId?: number): DetectedPlaylist[] {
  if (tabId !== undefined) {
    return Array.from(detectedPlaylists.values()).filter((p) => p.tabId === tabId);
  }
  return Array.from(detectedPlaylists.values());
}

/**
 * Get detected playlist by URL
 */
export function getDetectedPlaylist(url: string): DetectedPlaylist | undefined {
  return detectedPlaylists.get(url);
}

/**
 * Clear detected playlists (for cleanup)
 */
export function clearDetectedPlaylists(): void {
  detectedPlaylists.clear();
}

/**
 * Clear playlists for a specific tab
 */
export function clearPlaylistsForTab(tabId: number): void {
  for (const [url, playlist] of detectedPlaylists) {
    if (playlist.tabId === tabId) {
      detectedPlaylists.delete(url);
    }
  }
}

