/**
 * Blob URL save + revocation utilities
 */

import { MessageType } from "../../shared/messages";
import { getDownload, storeDownload } from "../database/downloads";
import { logger } from "./logger";

/**
 * Revoke a blob URL via the offscreen document.
 * Swallows errors to avoid masking caller errors.
 */
export function revokeBlobUrl(blobUrl: string): void {
  chrome.runtime.sendMessage(
    { type: MessageType.REVOKE_BLOB_URL, payload: { blobUrl } },
    () => {
      if (chrome.runtime.lastError) {
        // intentionally swallowed
      }
    },
  );
}

/**
 * Save a blob URL to a file via the Chrome downloads API.
 * Stores the chromeDownloadId in the download state for reliable cancellation.
 */
/** Maximum time to poll for download completion (5 minutes) */
const MAX_POLL_DURATION_MS = 5 * 60 * 1000;

export async function saveBlobUrlToFile(
  blobUrl: string,
  filename: string,
  stateId: string,
): Promise<string> {
  try {
    return await new Promise<string>((resolve, reject) => {
      chrome.downloads.download(
        {
          url: blobUrl,
          filename,
          saveAs: false,
        },
        async (downloadId) => {
          if (chrome.runtime.lastError) {
            logger.error(
              `Chrome downloads API error: ${chrome.runtime.lastError.message}`,
            );
            reject(new Error(chrome.runtime.lastError.message));
            return;
          }

          if (downloadId === undefined) {
            reject(new Error("Chrome downloads API returned no download ID"));
            return;
          }

          // Store chromeDownloadId in download state immediately
          const currentState = await getDownload(stateId);
          if (currentState) {
            currentState.chromeDownloadId = downloadId;
            await storeDownload(currentState);
          }

          // Wait for download to complete via onChanged event (no polling)
          const timeoutId = setTimeout(() => {
            chrome.downloads.onChanged.removeListener(onChange);
            reject(new Error("Download timed out after 5 minutes"));
          }, MAX_POLL_DURATION_MS);

          function onChange(delta: chrome.downloads.DownloadDelta) {
            if (delta.id !== downloadId || !delta.state) return;

            if (delta.state.current === "complete") {
              clearTimeout(timeoutId);
              chrome.downloads.onChanged.removeListener(onChange);
              revokeBlobUrl(blobUrl);
              // Retrieve filename from the completed download
              chrome.downloads.search({ id: downloadId }, (results) => {
                const item = results?.[0];
                resolve(item?.filename || filename);
              });
            } else if (delta.state.current === "interrupted") {
              clearTimeout(timeoutId);
              chrome.downloads.onChanged.removeListener(onChange);
              revokeBlobUrl(blobUrl);
              reject(new Error((delta as any).error?.current || "Download interrupted"));
            }
          }

          chrome.downloads.onChanged.addListener(onChange);
        },
      );
    });
  } catch (error) {
    revokeBlobUrl(blobUrl);
    throw error;
  }
}
