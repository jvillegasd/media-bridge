/**
 * Registers the MAIN-world MediaSource capture hook only while stream capture
 * is enabled in settings (off by default). When disabled, no script is
 * injected into page worlds at all.
 */

import { loadSettings } from "../core/storage/settings";
import { logger } from "../core/utils/logger";
import { CAPTURE_HOOK_SCRIPT_ID, STORAGE_CONFIG_KEY } from "../shared/constants";

let syncing: Promise<void> = Promise.resolve();

async function sync(): Promise<void> {
  const { capture } = await loadSettings();
  const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [CAPTURE_HOOK_SCRIPT_ID] });
  if (capture.enabled && existing.length === 0) {
    await chrome.scripting.registerContentScripts([
      {
        id: CAPTURE_HOOK_SCRIPT_ID,
        js: ["mse-capture.js"],
        matches: ["http://*/*", "https://*/*"],
        runAt: "document_start",
        allFrames: true,
        world: "MAIN",
        persistAcrossSessions: true,
      },
    ]);
    logger.info("Stream capture hook registered");
  } else if (!capture.enabled && existing.length > 0) {
    await chrome.scripting.unregisterContentScripts({ ids: [CAPTURE_HOOK_SCRIPT_ID] });
    logger.info("Stream capture hook unregistered");
  }
}

/** Serialize syncs so rapid setting toggles can't race register/unregister. */
export function syncCaptureHook(): Promise<void> {
  syncing = syncing.then(sync).catch((err) => logger.error("Capture hook sync failed:", err));
  return syncing;
}

export function initCaptureHook(): void {
  void syncCaptureHook();
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes[STORAGE_CONFIG_KEY]) void syncCaptureHook();
  });
}
