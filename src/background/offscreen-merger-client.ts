// Offscreen merger client is no longer needed for direct downloads
// This file can be kept for potential future use or removed entirely

export async function closeOffscreenDocument(): Promise<void> {
  if (!chrome.offscreen) {
    return;
  }

  const hasDocument = await chrome.offscreen.hasDocument?.();
  if (hasDocument) {
    await chrome.offscreen.closeDocument();
  }
}


