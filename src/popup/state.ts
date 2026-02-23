/**
 * Shared mutable state for the popup UI.
 *
 * All popup modules import from here instead of maintaining their own copies.
 * This avoids circular dependencies between render-videos, render-downloads,
 * and the manifest tab.
 */

import { DownloadState, VideoMetadata } from "../core/types";
import { getAllDownloads } from "../core/database/downloads";

// ---- Detected videos ----
export let detectedVideos: Record<string, VideoMetadata> = {};

export function setDetectedVideos(v: Record<string, VideoMetadata>): void {
  detectedVideos = v;
}

// ---- Download states ----
export let downloadStates: DownloadState[] = [];

export async function loadDownloadStates(): Promise<void> {
  downloadStates = await getAllDownloads();
  // Sort once by createdAt (newest first) — stable order that won't jump on progress updates
  downloadStates.sort((a, b) => b.createdAt - a.createdAt);
}

// ---- DOM element references (populated by init) ----
export const dom = {
  noVideoBtn: null as HTMLButtonElement | null,
  forceDetectionBtn: null as HTMLButtonElement | null,
  closeNoVideoNoticeBtn: null as HTMLButtonElement | null,
  noVideoNotice: null as HTMLDivElement | null,
  settingsBtn: null as HTMLButtonElement | null,
  downloadsBtn: null as HTMLButtonElement | null,
  clearCompletedBtn: null as HTMLButtonElement | null,
  autoDetectTab: null as HTMLButtonElement | null,
  manifestTab: null as HTMLButtonElement | null,
  downloadsTab: null as HTMLButtonElement | null,
  autoDetectContent: null as HTMLDivElement | null,
  manifestContent: null as HTMLDivElement | null,
  downloadsContent: null as HTMLDivElement | null,
  downloadsList: null as HTMLDivElement | null,
  startManifestDownloadBtn: null as HTMLButtonElement | null,
  loadManifestPlaylistBtn: null as HTMLButtonElement | null,
  videoQualitySelect: null as HTMLSelectElement | null,
  audioQualitySelect: null as HTMLSelectElement | null,
  manifestUrlInput: null as HTMLInputElement | null,
  manifestMediaPlaylistWarning: null as HTMLDivElement | null,
  manifestDrmWarning: null as HTMLDivElement | null,
  manifestUnsupportedWarning: null as HTMLDivElement | null,
  manifestLiveStreamInfo: null as HTMLDivElement | null,
  manifestQualitySelection: null as HTMLDivElement | null,
  manifestProgress: null as HTMLDivElement | null,
  detectedVideosList: null as HTMLDivElement | null,
  themeToggle: null as HTMLButtonElement | null,
  themeIcon: null as SVGElement | null,
};

// ---- Manifest tab flags ----
export let isMediaPlaylistMode = false;
export let isLiveManifest = false;
export let currentManualManifestUrl: string | null = null;
export let hasDrmInManifest = false;
export let unsupportedManifest = false;

export function setIsMediaPlaylistMode(v: boolean): void { isMediaPlaylistMode = v; }
export function setIsLiveManifest(v: boolean): void { isLiveManifest = v; }
export function setCurrentManualManifestUrl(v: string | null): void { currentManualManifestUrl = v; }
export function setHasDrmInManifest(v: boolean): void { hasDrmInManifest = v; }
export function setUnsupportedManifest(v: boolean): void { unsupportedManifest = v; }
