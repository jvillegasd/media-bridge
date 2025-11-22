/**
 * Offscreen document manager for FFmpeg processing
 * Creates and manages the offscreen document lifecycle
 */

import { logger } from "./logger";

const OFFSCREEN_DOCUMENT_PATH = "offscreen/offscreen.html";

/**
 * Check if offscreen document already exists
 */
async function hasOffscreenDocument(): Promise<boolean> {
  if (!chrome.offscreen) {
    return false;
  }

  try {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
      documentUrls: [chrome.runtime.getURL(OFFSCREEN_DOCUMENT_PATH)],
    });

    return contexts.length > 0;
  } catch (error) {
    logger.error("Failed to check for offscreen document:", error);
    return false;
  }
}

/**
 * Create offscreen document if it doesn't exist
 */
export async function createOffscreenDocument(): Promise<void> {
  if (!chrome.offscreen) {
    logger.warn("Offscreen API not available");
    return;
  }

  if (await hasOffscreenDocument()) {
    logger.debug("Offscreen document already exists");
    return;
  }

  try {
    await chrome.offscreen.createDocument({
      url: OFFSCREEN_DOCUMENT_PATH,
      reasons: [chrome.offscreen.Reason.WORKERS],
      justification: "FFmpeg processing for HLS video downloads",
    });
    logger.info("Offscreen document created");

    // Wait a bit for the offscreen document to fully load
    await new Promise((resolve) => setTimeout(resolve, 100));
  } catch (error) {
    logger.error("Failed to create offscreen document:", error);
    throw error;
  }
}

/**
 * Close offscreen document
 */
export async function closeOffscreenDocument(): Promise<void> {
  if (!chrome.offscreen) {
    return;
  }

  if (!(await hasOffscreenDocument())) {
    return;
  }

  try {
    await chrome.offscreen.closeDocument();
    logger.info("Offscreen document closed");
  } catch (error) {
    logger.error("Failed to close offscreen document:", error);
  }
}
