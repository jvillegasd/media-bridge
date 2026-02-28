/**
 * Manual manifest tab: load playlist, quality selection, start download.
 */

import { VideoMetadata, DownloadStage, VideoFormat } from "../core/types";
import { normalizeUrl, detectFormatFromUrl } from "../core/utils/url-utils";
import { parseMasterPlaylist, isMasterPlaylist, isMediaPlaylist } from "../core/utils/m3u8-parser";
import { hasDrm, canDecrypt } from "../core/utils/drm-utils";
import { MessageType } from "../shared/messages";
import {
  dom,
  loadDownloadStates,
  downloadStates,
  isMediaPlaylistMode,
  isLiveManifest,
  currentManualManifestUrl,
  hasDrmInManifest,
  unsupportedManifest,
  setIsMediaPlaylistMode,
  setIsLiveManifest,
  setCurrentManualManifestUrl,
  setHasDrmInManifest,
  setUnsupportedManifest,
} from "./state";
import { fetchTextViaBackground, formatQualityLabel } from "./utils";
import { renderDownloads } from "./render-downloads";
import { switchTab } from "./tabs";

const TAB_SWITCH_SETTLE_MS = 100;

/**
 * Update manual manifest form state based on download status and selections.
 */
export function updateManualManifestFormState(): void {
  const {
    manifestUrlInput,
    loadManifestPlaylistBtn,
    videoQualitySelect,
    audioQualitySelect,
    startManifestDownloadBtn,
  } = dom;

  let isDownloading = false;

  if (currentManualManifestUrl) {
    const normalizedUrl = normalizeUrl(currentManualManifestUrl);
    const downloadState = downloadStates.find((d) => {
      if (!d.metadata) return false;
      return normalizeUrl(d.metadata.url) === normalizedUrl;
    });

    if (downloadState) {
      isDownloading =
        downloadState.progress.stage !== DownloadStage.COMPLETED &&
        downloadState.progress.stage !== DownloadStage.FAILED;
    }
  }

  if (manifestUrlInput) manifestUrlInput.disabled = isDownloading;
  if (loadManifestPlaylistBtn) loadManifestPlaylistBtn.disabled = isDownloading;
  if (videoQualitySelect) {
    videoQualitySelect.disabled =
      isDownloading || videoQualitySelect.options.length <= 1;
  }
  if (audioQualitySelect) {
    audioQualitySelect.disabled =
      isDownloading || audioQualitySelect.options.length <= 1;
  }

  if (!startManifestDownloadBtn) return;

  if (hasDrmInManifest) {
    startManifestDownloadBtn.disabled = true;
    return;
  }

  if (unsupportedManifest) {
    startManifestDownloadBtn.disabled = true;
    return;
  }

  if (isDownloading) {
    startManifestDownloadBtn.disabled = true;
    return;
  }

  if (isMediaPlaylistMode) {
    startManifestDownloadBtn.disabled = false;
    return;
  }

  if (!videoQualitySelect || !audioQualitySelect) {
    startManifestDownloadBtn.disabled = true;
    return;
  }

  const videoSelected = videoQualitySelect.value !== "";
  const audioSelected = audioQualitySelect.value !== "";

  startManifestDownloadBtn.disabled = !(videoSelected || audioSelected);
  startManifestDownloadBtn.textContent = isLiveManifest ? "Record" : "Download";
}

export function updateDownloadButtonState(): void {
  updateManualManifestFormState();
}

export async function handleSendToManifestTab(url: string): Promise<void> {
  await switchTab("manual");
  await new Promise((resolve) => setTimeout(resolve, TAB_SWITCH_SETTLE_MS));

  if (dom.manifestUrlInput) {
    dom.manifestUrlInput.value = url;
  }

  await handleLoadManifestPlaylist();
}

export async function handleLoadManifestPlaylist(): Promise<void> {
  const { manifestUrlInput, loadManifestPlaylistBtn } = dom;
  if (!manifestUrlInput || !loadManifestPlaylistBtn) return;

  const rawUrl = manifestUrlInput.value.trim();

  if (!rawUrl) {
    alert("Please enter a manifest URL");
    return;
  }

  const normalizedUrl = normalizeUrl(rawUrl);

  const format = detectFormatFromUrl(normalizedUrl);
  if (format !== VideoFormat.HLS) {
    alert("Please enter a valid manifest URL (.m3u8 or .mpd)");
    return;
  }

  manifestUrlInput.value = normalizedUrl;

  loadManifestPlaylistBtn.disabled = true;
  loadManifestPlaylistBtn.textContent = "Loading...";

  if (dom.manifestMediaPlaylistWarning) dom.manifestMediaPlaylistWarning.style.display = "none";
  if (dom.manifestLiveStreamInfo) dom.manifestLiveStreamInfo.style.display = "none";
  if (dom.manifestDrmWarning) dom.manifestDrmWarning.style.display = "none";
  if (dom.manifestUnsupportedWarning) dom.manifestUnsupportedWarning.style.display = "none";
  if (dom.manifestQualitySelection) dom.manifestQualitySelection.style.display = "none";

  setHasDrmInManifest(false);
  setIsLiveManifest(false);
  setUnsupportedManifest(false);

  try {
    const playlistText = await fetchTextViaBackground(normalizedUrl);

    setHasDrmInManifest(hasDrm(playlistText));
    setUnsupportedManifest(!canDecrypt(playlistText));

    if (hasDrmInManifest) {
      if (dom.manifestDrmWarning) dom.manifestDrmWarning.style.display = "block";
      if (dom.manifestUnsupportedWarning) dom.manifestUnsupportedWarning.style.display = "none";
      if (dom.manifestMediaPlaylistWarning) dom.manifestMediaPlaylistWarning.style.display = "none";
      if (dom.manifestLiveStreamInfo) dom.manifestLiveStreamInfo.style.display = "none";
      if (dom.manifestQualitySelection) dom.manifestQualitySelection.style.display = "none";
      if (dom.startManifestDownloadBtn) dom.startManifestDownloadBtn.disabled = true;
      updateManualManifestFormState();
      return;
    }

    if (unsupportedManifest) {
      if (dom.manifestUnsupportedWarning) dom.manifestUnsupportedWarning.style.display = "block";
      if (dom.manifestDrmWarning) dom.manifestDrmWarning.style.display = "none";
      if (dom.manifestMediaPlaylistWarning) dom.manifestMediaPlaylistWarning.style.display = "none";
      if (dom.manifestLiveStreamInfo) dom.manifestLiveStreamInfo.style.display = "none";
      if (dom.manifestQualitySelection) dom.manifestQualitySelection.style.display = "none";
      if (dom.startManifestDownloadBtn) dom.startManifestDownloadBtn.disabled = true;
      updateManualManifestFormState();
      return;
    }

    if (isMediaPlaylist(playlistText)) {
      setIsMediaPlaylistMode(true);
      setIsLiveManifest(!playlistText.includes("#EXT-X-ENDLIST"));
      if (dom.manifestMediaPlaylistWarning) {
        dom.manifestMediaPlaylistWarning.style.display = isLiveManifest ? "none" : "block";
      }
      if (dom.manifestLiveStreamInfo) {
        dom.manifestLiveStreamInfo.style.display = isLiveManifest ? "block" : "none";
        const infoText = document.getElementById("hlsLiveStreamInfoText");
        if (infoText) {
          infoText.textContent = "This is a live stream. Click Record to start capturing the stream.";
        }
      }
      if (dom.manifestQualitySelection) {
        dom.manifestQualitySelection.style.display = "none";
      }
    } else if (isMasterPlaylist(playlistText)) {
      setIsMediaPlaylistMode(false);
      if (dom.manifestMediaPlaylistWarning) dom.manifestMediaPlaylistWarning.style.display = "none";
      const { videoQualitySelect, audioQualitySelect, manifestQualitySelection } = dom;
      if (manifestQualitySelection && videoQualitySelect && audioQualitySelect) {
        manifestQualitySelection.style.display = "block";

        const levels = parseMasterPlaylist(playlistText, normalizedUrl);
        const videoLevels = levels.filter((level) => level.type === "stream");
        const audioLevels = levels.filter((level) => level.type === "audio");

        setIsLiveManifest(false);
        if (videoLevels.length > 0) {
          try {
            const variantText = await fetchTextViaBackground(videoLevels[0]!.uri);
            setIsLiveManifest(!variantText.includes("#EXT-X-ENDLIST"));
          } catch {}
        }

        if (dom.manifestLiveStreamInfo) {
          dom.manifestLiveStreamInfo.style.display = isLiveManifest ? "block" : "none";
          const infoText = document.getElementById("hlsLiveStreamInfoText");
          if (infoText) {
            infoText.textContent = "This is a live stream. Select a quality and click Record to start capturing the stream.";
          }
        }

        videoQualitySelect.innerHTML = '<option value="">None (audio only)</option>';
        videoLevels.forEach((level, index) => {
          const option = document.createElement("option");
          option.value = level.uri;
          option.textContent = formatQualityLabel(level);
          option.setAttribute("data-level-index", index.toString());
          videoQualitySelect!.appendChild(option);
        });
        videoQualitySelect.disabled = false;

        audioQualitySelect.innerHTML = '<option value="">None (video only)</option>';
        audioLevels.forEach((level, index) => {
          const option = document.createElement("option");
          option.value = level.uri;
          option.textContent = level.id;
          option.setAttribute("data-level-index", index.toString());
          audioQualitySelect!.appendChild(option);
        });
        audioQualitySelect.disabled = false;

        if (videoLevels.length > 0 && videoQualitySelect.options.length > 1) {
          videoQualitySelect.selectedIndex = 1;
        }
        if (audioLevels.length > 0 && audioQualitySelect.options.length > 1) {
          audioQualitySelect.selectedIndex = 1;
        }

        updateDownloadButtonState();
      }
    } else {
      throw new Error("Invalid playlist format");
    }

    updateManualManifestFormState();
  } catch (error) {
    console.error("Failed to load manifest:", error);
    alert("Failed to load manifest. Please check the URL and try again.");
    if (dom.manifestMediaPlaylistWarning) dom.manifestMediaPlaylistWarning.style.display = "none";
    if (dom.manifestLiveStreamInfo) dom.manifestLiveStreamInfo.style.display = "none";
    if (dom.manifestDrmWarning) dom.manifestDrmWarning.style.display = "none";
    if (dom.manifestUnsupportedWarning) dom.manifestUnsupportedWarning.style.display = "none";
    if (dom.manifestQualitySelection) dom.manifestQualitySelection.style.display = "none";
    setHasDrmInManifest(false);
    setUnsupportedManifest(false);
    setIsLiveManifest(false);
    updateManualManifestFormState();
  } finally {
    if (loadManifestPlaylistBtn) {
      loadManifestPlaylistBtn.disabled = false;
      loadManifestPlaylistBtn.textContent = "Load";
    }
  }
}

export async function handleStartManifestDownload(): Promise<void> {
  const { manifestUrlInput, startManifestDownloadBtn, videoQualitySelect, audioQualitySelect, manifestProgress } = dom;
  if (!manifestUrlInput || !startManifestDownloadBtn) return;

  const rawPlaylistUrl = manifestUrlInput.value.trim();

  if (!rawPlaylistUrl) {
    alert("Please enter a manifest URL");
    return;
  }

  const playlistUrl = normalizeUrl(rawPlaylistUrl);

  let videoPlaylistUrl: string | null = null;
  let audioPlaylistUrl: string | null = null;

  if (!isMediaPlaylistMode) {
    if (!videoQualitySelect || !audioQualitySelect) return;

    const rawVideoUrl = videoQualitySelect.value || null;
    const rawAudioUrl = audioQualitySelect.value || null;

    videoPlaylistUrl = rawVideoUrl ? normalizeUrl(rawVideoUrl) : null;
    audioPlaylistUrl = rawAudioUrl ? normalizeUrl(rawAudioUrl) : null;

    if (!videoPlaylistUrl && !audioPlaylistUrl) {
      alert("Please select at least one quality (video or audio)");
      return;
    }
  }

  startManifestDownloadBtn.textContent = "Starting...";

  if (manifestUrlInput) manifestUrlInput.disabled = true;
  if (dom.loadManifestPlaylistBtn) dom.loadManifestPlaylistBtn.disabled = true;
  if (videoQualitySelect) videoQualitySelect.disabled = true;
  if (audioQualitySelect) audioQualitySelect.disabled = true;
  startManifestDownloadBtn.disabled = true;

  try {
    let tabTitle: string | undefined;
    let website: string | undefined;
    let pageUrl: string = "";
    try {
      const [tab] = await chrome.tabs.query({
        active: true,
        currentWindow: true,
      });
      if (tab) {
        tabTitle = tab.title || undefined;
        if (tab.url) {
          pageUrl = tab.url;
          try {
            const urlObj = new URL(tab.url);
            website = urlObj.hostname.replace(/^www\./, "");
          } catch {}
        }
      }
    } catch (error) {
      console.debug("Could not get tab information:", error);
    }

    const metadata: VideoMetadata = {
      url: playlistUrl,
      format: isMediaPlaylistMode ? VideoFormat.M3U8 : VideoFormat.HLS,
      title: tabTitle || "Manifest Video",
      pageUrl: pageUrl || window.location.href,
      isLive: isLiveManifest,
    };

    const messageType = isLiveManifest
      ? MessageType.START_RECORDING
      : MessageType.DOWNLOAD_REQUEST;

    const recordingUrl = isLiveManifest && videoPlaylistUrl
      ? videoPlaylistUrl
      : playlistUrl;

    const payload = isLiveManifest
      ? { url: recordingUrl, metadata, tabTitle, website }
      : {
          url: playlistUrl,
          metadata,
          tabTitle,
          website,
          manifestQuality: isMediaPlaylistMode
            ? undefined
            : {
                videoPlaylistUrl,
                audioPlaylistUrl,
              },
          isManual: true,
        };

    const response = await new Promise<any>((resolve, reject) => {
      chrome.runtime.sendMessage(
        { type: messageType, payload },
        (response) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
            return;
          }
          resolve(response);
        },
      );
    });

    const buttonLabel = isLiveManifest ? "Record" : "Download";

    if (response && response.success) {
      setCurrentManualManifestUrl(null);
      if (manifestProgress) manifestProgress.style.display = "none";
      if (startManifestDownloadBtn) startManifestDownloadBtn.textContent = buttonLabel;
      updateManualManifestFormState();
      await loadDownloadStates();
      await switchTab("downloads");
      renderDownloads();
    } else if (response && response.error) {
      alert(response.error);
      startManifestDownloadBtn.textContent = buttonLabel;
      updateManualManifestFormState();
    }
  } catch (error: any) {
    console.error("Download request failed:", error);
    alert("Failed to start download: " + (error?.message || "Unknown error"));
    startManifestDownloadBtn.textContent = isLiveManifest ? "Record" : "Download";
    updateManualManifestFormState();
  }
}
