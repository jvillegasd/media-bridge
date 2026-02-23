/**
 * Download action handlers (open, remove, retry, start download).
 */

import { VideoMetadata, DownloadStage } from "../core/types";
import { getDownload, deleteDownload } from "../core/database/downloads";
import { MessageType } from "../shared/messages";
import { canCancelDownload, CANNOT_CANCEL_MESSAGE } from "../core/utils/download-utils";
import { loadDownloadStates } from "./state";
import { renderDownloads } from "./render-downloads";
import { renderDetectedVideos } from "./render-videos";

export async function handleOpenDownload(downloadId: string): Promise<void> {
  try {
    const download = await getDownload(downloadId);
    if (!download || !download.localPath) {
      alert("Download file not found");
      return;
    }

    const filename = download.localPath.split(/[/\\]/).pop();
    if (!filename) {
      alert("Could not determine filename");
      return;
    }

    const downloads = await new Promise<chrome.downloads.DownloadItem[]>(
      (resolve) => {
        chrome.downloads.search({ filenameRegex: filename }, resolve);
      },
    );

    if (downloads.length > 0) {
      chrome.downloads.show(downloads[0].id);
    } else {
      await chrome.downloads.showDefaultFolder();
    }
  } catch (error) {
    console.error("Failed to open download:", error);
    alert("Failed to open download file");
  }
}

export async function handleRemoveDownload(downloadId: string): Promise<void> {
  try {
    const download = await getDownload(downloadId);
    if (!download) return;

    const isInProgress =
      download.progress.stage !== DownloadStage.COMPLETED &&
      download.progress.stage !== DownloadStage.FAILED &&
      download.progress.stage !== DownloadStage.CANCELLED;

    if (isInProgress) {
      if (!canCancelDownload(download.progress.stage)) {
        alert(CANNOT_CANCEL_MESSAGE);
        return;
      }

      if (!confirm("Are you sure you want to cancel this download?")) return;

      try {
        const response = await new Promise<any>((resolve, reject) => {
          chrome.runtime.sendMessage(
            {
              type: MessageType.CANCEL_DOWNLOAD,
              payload: { id: downloadId },
            },
            (response) => {
              if (chrome.runtime.lastError) {
                reject(new Error(chrome.runtime.lastError.message));
                return;
              }
              resolve(response);
            },
          );
        });

        if (response && response.success) {
          await loadDownloadStates();
          renderDownloads();
          renderDetectedVideos();
        } else if (response && response.error) {
          alert(response.error);
        }
      } catch (error: any) {
        console.error("Failed to cancel download:", error);
        alert("Failed to cancel download: " + (error?.message || "Unknown error"));
      }
    } else {
      if (!confirm("Are you sure you want to remove this download?")) return;

      await deleteDownload(downloadId);
      await loadDownloadStates();
      renderDownloads();
    }
  } catch (error) {
    console.error("Failed to remove download:", error);
    alert("Failed to remove download");
  }
}

export async function handleRetryDownload(downloadId: string): Promise<void> {
  try {
    const download = await getDownload(downloadId);
    if (!download) {
      alert("Download not found");
      return;
    }

    let website: string | undefined;
    try {
      const urlObj = new URL(download.metadata.pageUrl);
      website = urlObj.hostname.replace(/^www\./, "");
    } catch {
      if (download.url) {
        try {
          const urlObj = new URL(download.url);
          website = urlObj.hostname.replace(/^www\./, "");
        } catch {}
      }
    }

    const tabTitle = download.metadata.title;
    await deleteDownload(downloadId);

    const response = await new Promise<any>((resolve, reject) => {
      chrome.runtime.sendMessage(
        {
          type: MessageType.DOWNLOAD_REQUEST,
          payload: {
            url: download.url,
            metadata: download.metadata,
            tabTitle,
            website,
          },
        },
        (response) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
            return;
          }
          resolve(response);
        },
      );
    });

    if (response && response.success) {
      await loadDownloadStates();
      renderDownloads();
    } else if (response && response.error) {
      alert(response.error);
    }
  } catch (error: any) {
    console.error("Failed to retry download:", error);
    alert("Failed to retry download: " + (error?.message || "Unknown error"));
  }
}

export async function startDownload(
  url: string,
  videoMetadata?: VideoMetadata,
  options: { triggerButton?: HTMLButtonElement } = {},
): Promise<void> {
  const triggerButton = options.triggerButton;
  const originalText = triggerButton?.textContent;
  if (triggerButton) {
    triggerButton.disabled = true;
    triggerButton.classList.add("disabled");
    triggerButton.textContent = "Starting...";
  }

  let shouldResetButton = false;

  try {
    if (chrome.runtime.lastError) {
      if (
        chrome.runtime.lastError.message?.includes(
          "Extension context invalidated",
        )
      ) {
        alert(
          "Extension was reloaded. Please refresh this page and try again.",
        );
        shouldResetButton = true;
        return;
      }
    }

    let tabTitle: string | undefined;
    let website: string | undefined;
    try {
      const [tab] = await chrome.tabs.query({
        active: true,
        currentWindow: true,
      });
      if (tab) {
        tabTitle = tab.title || undefined;
        if (tab.url) {
          try {
            const urlObj = new URL(tab.url);
            website = urlObj.hostname.replace(/^www\./, "");
          } catch {}
        }
      }
    } catch (error) {
      console.debug("Could not get tab information:", error);
    }

    const response = await new Promise<any>((resolve, reject) => {
      chrome.runtime.sendMessage(
        {
          type: MessageType.DOWNLOAD_REQUEST,
          payload: {
            url,
            metadata: videoMetadata,
            tabTitle,
            website,
          },
        },
        (response) => {
          if (chrome.runtime.lastError) {
            const errorMessage = chrome.runtime.lastError.message || "";
            if (errorMessage.includes("Extension context invalidated")) {
              reject(
                new Error(
                  "Extension context invalidated. Please reload the extension and try again.",
                ),
              );
              return;
            }
            reject(
              new Error(chrome.runtime.lastError.message || "Unknown error"),
            );
            return;
          }
          resolve(response);
        },
      );
    }).catch((error: any) => {
      if (error?.message?.includes("Extension context invalidated")) {
        throw new Error(
          "Extension context invalidated. Please reload the extension and try again.",
        );
      }
      throw error;
    });

    if (response && response.success) {
      await loadDownloadStates();
      renderDetectedVideos();
    } else if (response && response.error) {
      const errorMessage = response.error;
      if (
        !errorMessage.includes("already") &&
        !errorMessage.includes("in progress")
      ) {
        alert(response.error);
      }
      await loadDownloadStates();
      renderDetectedVideos();
      shouldResetButton = true;
    }
  } catch (error: any) {
    console.error("Download request failed:", error);
    if (
      error?.message?.includes("Extension context invalidated") ||
      chrome.runtime.lastError?.message?.includes(
        "Extension context invalidated",
      )
    ) {
      alert(
        "Extension was reloaded. Please close and reopen this popup, then try again.",
      );
    } else {
      alert("Failed to start download: " + (error?.message || "Unknown error"));
    }
    shouldResetButton = true;
  } finally {
    if (shouldResetButton && triggerButton && triggerButton.isConnected) {
      triggerButton.disabled = false;
      triggerButton.classList.remove("disabled");
      triggerButton.textContent = originalText || "Download";
    }
  }
}
