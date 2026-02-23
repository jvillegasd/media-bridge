/**
 * Tab switching logic, extracted to break circular dependency
 * between popup.ts and render-manifest.ts.
 */

import { dom, loadDownloadStates } from "./state";
import { renderDownloads } from "./render-downloads";
import { updateManualManifestFormState } from "./render-manifest";

export async function switchTab(tabName: "auto" | "manual" | "downloads"): Promise<void> {
  if (tabName === "auto") {
    if (dom.autoDetectTab) dom.autoDetectTab.classList.add("active");
    if (dom.manifestTab) dom.manifestTab.classList.remove("active");
    if (dom.downloadsTab) dom.downloadsTab.classList.remove("active");
    if (dom.autoDetectContent) dom.autoDetectContent.classList.add("active");
    if (dom.manifestContent) dom.manifestContent.classList.remove("active");
    if (dom.downloadsContent) dom.downloadsContent.classList.remove("active");
  } else if (tabName === "manual") {
    if (dom.autoDetectTab) dom.autoDetectTab.classList.remove("active");
    if (dom.manifestTab) dom.manifestTab.classList.add("active");
    if (dom.downloadsTab) dom.downloadsTab.classList.remove("active");
    if (dom.autoDetectContent) dom.autoDetectContent.classList.remove("active");
    if (dom.manifestContent) dom.manifestContent.classList.add("active");
    if (dom.downloadsContent) dom.downloadsContent.classList.remove("active");

    updateManualManifestFormState();
  } else if (tabName === "downloads") {
    if (dom.autoDetectTab) dom.autoDetectTab.classList.remove("active");
    if (dom.manifestTab) dom.manifestTab.classList.remove("active");
    if (dom.downloadsTab) dom.downloadsTab.classList.add("active");
    if (dom.autoDetectContent) dom.autoDetectContent.classList.remove("active");
    if (dom.manifestContent) dom.manifestContent.classList.remove("active");
    if (dom.downloadsContent) dom.downloadsContent.classList.add("active");

    await loadDownloadStates();
    renderDownloads();
  }
}
