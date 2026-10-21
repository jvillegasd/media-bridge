/**
 * Capture bridge — a hidden, web-accessible extension page embedded by the
 * content script while saving a MediaSource capture.
 *
 * It receives a MessagePort plus a one-time token from the content script,
 * writes transferred segment buffers into the extension's IndexedDB `chunks`
 * store (same layout as DASH downloads: video under `downloadId`, audio under
 * `${downloadId}_a`), then asks the service worker to mux and save.
 *
 * The page can see this iframe but never the token: the token travels from the
 * service worker to the isolated content script and then over postMessage to
 * this exact extension origin. The service worker rejects unknown tokens.
 */

import { storeChunk } from "../core/database/chunks";
import { MessageType } from "../shared/messages";

const BRIDGE_CHANNEL = "__media_bridge_bridge__";
const VALID_ID = /^[a-zA-Z0-9_-]+$/;

let claimed = false;

window.addEventListener("message", (event) => {
  const data = event.data;
  if (claimed || !data || data.channel !== BRIDGE_CHANNEL) return;
  const port = event.ports[0];
  const { token, downloadId } = data as { token?: string; downloadId?: string };
  if (!port || typeof token !== "string" || typeof downloadId !== "string" || !VALID_ID.test(downloadId)) {
    return;
  }
  claimed = true;

  const writes: Promise<void>[] = [];
  let failed: string | null = null;

  port.onmessage = async (ev) => {
    const m = ev.data;
    if (m?.type === "chunk") {
      if (!(m.data instanceof ArrayBuffer) || typeof m.index !== "number") return;
      const id = m.slot === "audio" ? `${downloadId}_a` : downloadId;
      writes.push(
        storeChunk(id, m.index, m.data).catch((err) => {
          failed = err instanceof Error ? err.message : String(err);
        }),
      );
      return;
    }

    if (m?.type === "done") {
      await Promise.all(writes);
      if (failed) {
        port.postMessage({ type: "result", success: false, error: `Storing capture failed: ${failed}` });
        return;
      }
      chrome.runtime.sendMessage(
        {
          type: MessageType.CAPTURE_FINALIZE,
          payload: {
            token,
            downloadId,
            videoLength: m.videoLength,
            audioLength: m.audioLength,
          },
        },
        (response) => {
          if (chrome.runtime.lastError) {
            port.postMessage({ type: "result", success: false, error: chrome.runtime.lastError.message });
            return;
          }
          port.postMessage({ type: "result", success: !!response?.success, error: response?.error });
        },
      );
    }
  };
});
