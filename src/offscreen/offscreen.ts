// Offscreen document is no longer needed for HLS/DASH merging
// This file can be kept for potential future use or removed entirely

import { MessageType } from '../shared/messages';
import { logger } from '../core/utils/logger';

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type !== MessageType.OFFSCREEN_MERGE_REQUEST) {
    return false;
  }

  // HLS/DASH merging is no longer supported
  logger.warn('HLS/DASH merging is no longer supported. Only direct downloads are available.');
  sendResponse({
    success: false,
    error: 'HLS/DASH merging is no longer supported. Only direct video downloads are available.',
  });
  
  return false;
});


