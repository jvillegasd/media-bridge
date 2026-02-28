/**
 * Pure utility functions shared across popup modules.
 */

import { DownloadState, VideoMetadata, VideoFormat, DownloadStage, Level } from "../core/types";
import { normalizeUrl } from "../core/utils/url-utils";
import { formatFileSize } from "../core/utils/format-utils";
import { MessageType } from "../shared/messages";
import { downloadStates } from "./state";

const MAX_URL_DISPLAY_LENGTH = 50;

export function getVideoTitleFromUrl(url: string): string {
  try {
    const urlObj = new URL(url);
    const pathname = urlObj.pathname;
    const filename = pathname.split("/").pop();
    return filename || url.substring(0, MAX_URL_DISPLAY_LENGTH) + "...";
  } catch {
    return url.substring(0, MAX_URL_DISPLAY_LENGTH) + "...";
  }
}

export function getStatusText(stage: DownloadStage): string {
  const statusMap: Record<DownloadStage, string> = {
    [DownloadStage.DETECTING]: "Detecting",
    [DownloadStage.DOWNLOADING]: "Downloading",
    [DownloadStage.RECORDING]: "Recording",
    [DownloadStage.MERGING]: "Merging",
    [DownloadStage.SAVING]: "Saving",
    [DownloadStage.UPLOADING]: "Uploading",
    [DownloadStage.COMPLETED]: "Completed",
    [DownloadStage.FAILED]: "Failed",
    [DownloadStage.CANCELLED]: "Cancelled",
  };
  return statusMap[stage] || stage;
}

export function getActualFileFormat(
  video: VideoMetadata,
  downloadState?: DownloadState,
): string | null {
  if (downloadState?.localPath) {
    const ext = downloadState.localPath.split(".").pop()?.toUpperCase();
    if (
      ext &&
      ["MP4", "WEBM", "MOV", "AVI", "MKV", "FLV", "WMV", "OGG"].includes(ext)
    ) {
      return ext;
    }
  }

  try {
    const url = new URL(video.url);
    const pathname = url.pathname.toLowerCase();
    const extensionMatch = pathname.match(
      /\.(mp4|webm|mov|avi|mkv|flv|wmv|ogg)(\?|$|#)/,
    );
    if (extensionMatch && extensionMatch[1]) {
      return extensionMatch[1].toUpperCase();
    }
  } catch {
    const urlLower = video.url.toLowerCase();
    const extensionMatch = urlLower.match(
      /\.(mp4|webm|mov|avi|mkv|flv|wmv|ogg)(\?|$|#)/,
    );
    if (extensionMatch && extensionMatch[1]) {
      return extensionMatch[1].toUpperCase();
    }
  }

  return null;
}

export function getFormatDisplayName(
  format: VideoFormat,
  actualFormat?: string | null,
): string {
  if (actualFormat) return actualFormat;
  if (format === VideoFormat.DIRECT) return "MP4";
  return format.toUpperCase();
}

export function getLinkTypeDisplayName(format: VideoFormat): string {
  switch (format) {
    case VideoFormat.DIRECT:
      return "Direct";
    case VideoFormat.HLS:
      return "HLS";
    case VideoFormat.M3U8:
      return "M3U8";
    default:
      return format.toUpperCase();
  }
}

export function formatDuration(seconds: number): string {
  if (!seconds || seconds <= 0) return "";
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);

  if (hours > 0) {
    return `${hours}:${minutes.toString().padStart(2, "0")}:${secs
      .toString()
      .padStart(2, "0")}`;
  }
  return `${minutes}:${secs.toString().padStart(2, "0")}`;
}

export function formatSpeed(bytesPerSecond: number): string {
  if (bytesPerSecond <= 0) return "";
  if (bytesPerSecond < 1024) return `${Math.round(bytesPerSecond)} B/s`;
  if (bytesPerSecond < 1024 * 1024) {
    return `${(bytesPerSecond / 1024).toFixed(1)} KB/s`;
  }
  return `${(bytesPerSecond / (1024 * 1024)).toFixed(1)} MB/s`;
}

export function escapeHtml(text: string): string {
  const el = document.createElement("span");
  el.textContent = text;
  return el.innerHTML;
}

export async function fetchTextViaBackground(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(
      {
        type: MessageType.FETCH_RESOURCE,
        payload: {
          input: url,
          init: { method: "GET" },
        },
      },
      (response: [any, Error | null] | undefined) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        if (!response) {
          reject(new Error("No response from background script"));
          return;
        }
        const [res, error] = response;
        if (error) {
          reject(error);
          return;
        }
        if (res && res.status === 200 && res.body) {
          const bytes = new Uint8Array(res.body);
          const text = new TextDecoder().decode(bytes);
          resolve(text);
        } else {
          reject(
            new Error(`Failed to fetch: ${res?.status || "unknown status"}`),
          );
        }
      },
    );
  });
}

export function formatQualityLabel(level: Level): string {
  const parts: string[] = [];

  if (level.height) {
    parts.push(`${level.height}p`);
  } else if (level.width && level.height) {
    parts.push(`${level.width}x${level.height}`);
  }

  if (level.bitrate) {
    const bitrateMbps = (level.bitrate / 1000000).toFixed(2);
    parts.push(`${bitrateMbps} Mbps`);
  }

  if (level.fps) {
    parts.push(`${level.fps} fps`);
  }

  return parts.length > 0 ? parts.join(" \u2022 ") : "Unknown";
}

export function getDownloadStateForVideo(
  video: VideoMetadata,
): DownloadState | undefined {
  const normalizedUrl = normalizeUrl(video.url);
  return downloadStates.find((d) => {
    if (!d.metadata) return false;
    return normalizeUrl(d.metadata.url) === normalizedUrl;
  });
}

export { formatFileSize };
