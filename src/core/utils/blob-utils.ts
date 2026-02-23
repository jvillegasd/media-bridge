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

          // Wait for download to complete with a timeout guard
          const pollStart = Date.now();
          const checkComplete = () => {
            if (Date.now() - pollStart > MAX_POLL_DURATION_MS) {
              reject(new Error("Download polling timed out after 5 minutes"));
              return;
            }

            chrome.downloads.search({ id: downloadId }, (results) => {
              if (chrome.runtime.lastError) {
                reject(new Error(chrome.runtime.lastError.message));
                return;
              }

              const item = results?.[0];
              if (!item) {
                reject(new Error("Download item not found"));
                return;
              }

              if (item.state === "complete") {
                revokeBlobUrl(blobUrl);
                resolve(item.filename);
              } else if (item.state === "interrupted") {
                revokeBlobUrl(blobUrl);
                reject(new Error(item.error || "Download interrupted"));
              } else {
                setTimeout(checkComplete, 100);
              }
            });
          };

          checkComplete();
        },
      );
    });
  } catch (error) {
    revokeBlobUrl(blobUrl);
    throw error;
  }
}
