/**
 * Options page logic
 * Sections: init/routing, download settings, cloud providers, history
 */

import { ChromeStorage } from "../core/storage/chrome-storage";
import { loadSettings } from "../core/storage/settings";
import { GoogleAuth, GOOGLE_DRIVE_SCOPES } from "../core/cloud/google-auth";
import { StorageConfig, DownloadState, DownloadStage, VideoMetadata } from "../core/types";
import { MessageType } from "../shared/messages";
import {
  getAllDownloads,
  getDownload,
  deleteDownload,
  bulkDeleteDownloads,
  clearAllDownloads,
} from "../core/database/downloads";
import {
  DEFAULT_MAX_CONCURRENT,
  STORAGE_CONFIG_KEY,
  DEFAULT_MAX_RETRIES,
  DEFAULT_MIN_POLL_MS,
  DEFAULT_MAX_POLL_MS,
  DEFAULT_POLL_FRACTION,
  DEFAULT_DETECTION_CACHE_SIZE,
  DEFAULT_MASTER_PLAYLIST_CACHE_SIZE,
  DEFAULT_DB_SYNC_INTERVAL_MS,
  INITIAL_RETRY_DELAY_MS,
  RETRY_BACKOFF_FACTOR,
  MAX_FRAGMENT_FAILURE_RATE,
  DEFAULT_GOOGLE_DRIVE_FOLDER_NAME,
} from "../shared/constants";

import {
  TOAST_DURATION_MS,
  MS_PER_DAY,
  DEFAULT_FFMPEG_TIMEOUT_S,
  MIN_FFMPEG_TIMEOUT_S,
  MAX_FFMPEG_TIMEOUT_S,
  MIN_POLL_MIN_S,
  MAX_POLL_MIN_S,
  MIN_POLL_MAX_S,
  MAX_POLL_MAX_S,
  MIN_POLL_FRACTION,
  MAX_POLL_FRACTION,
  MIN_MAX_RETRIES,
  MAX_MAX_RETRIES,
  MIN_RETRY_DELAY_S,
  MAX_RETRY_DELAY_S,
  MIN_RETRY_BACKOFF_FACTOR,
  MAX_RETRY_BACKOFF_FACTOR,
  MIN_FAILURE_RATE,
  MAX_FAILURE_RATE,
  MIN_DETECTION_CACHE_SIZE,
  MAX_DETECTION_CACHE_SIZE,
  MIN_MASTER_PLAYLIST_CACHE_SIZE,
  MAX_MASTER_PLAYLIST_CACHE_SIZE,
  MIN_DB_SYNC_S,
  MAX_DB_SYNC_S,
} from "./constants";

const FINISHED_STAGES = new Set([
  DownloadStage.COMPLETED,
  DownloadStage.FAILED,
  DownloadStage.CANCELLED,
]);

// ─────────────────────────────────────────────
// Section: Init & Routing
// ─────────────────────────────────────────────

function init(): void {
  loadTheme();
  setupNavigation();
  setupThemeToggle();

  // Check URL hash to navigate directly to a view (e.g. opened via history button)
  const hash = location.hash.slice(1);
  const validViews = new Set(["history", "cloud-providers", "recording", "notifications", "advanced"]);
  switchView(validViews.has(hash) ? hash : "download-settings");
}

function setupNavigation(): void {
  document.querySelectorAll<HTMLButtonElement>(".nav-item").forEach((btn) => {
    btn.addEventListener("click", () => {
      const viewId = btn.dataset.view;
      if (viewId) switchView(viewId);
    });
  });
}

const initializedViews = new Set<string>();

function switchView(viewId: string): void {
  document.querySelectorAll(".view").forEach((v) => v.classList.remove("active"));
  document.querySelectorAll(".nav-item").forEach((b) => b.classList.remove("active"));

  const view = document.getElementById(`view-${viewId}`);
  if (view) view.classList.add("active");

  const navBtn = document.querySelector<HTMLButtonElement>(
    `.nav-item[data-view="${viewId}"]`,
  );
  if (navBtn) navBtn.classList.add("active");

  // Keep URL in sync so refresh restores the same section
  history.replaceState(null, "", `#${viewId}`);

  if (initializedViews.has(viewId)) return;
  initializedViews.add(viewId);

  // Lazy-load view content on first activation
  if (viewId === "download-settings") loadDownloadSettings();
  if (viewId === "history") loadHistory();
  if (viewId === "cloud-providers") {
    loadDriveSettings();
    loadS3Settings();
    setupCloudProviderTabs();
  }
  if (viewId === "recording") loadRecordingSettings();
  if (viewId === "notifications") loadNotificationSettings();
  if (viewId === "advanced") loadAdvancedSettings();
}

// ─────────────────────────────────────────────
// Section: Theme
// ─────────────────────────────────────────────

function setupThemeToggle(): void {
  const btn = document.getElementById("theme-toggle");
  if (btn) btn.addEventListener("click", toggleTheme);
}

async function loadTheme(): Promise<void> {
  const theme = await ChromeStorage.get<string>("theme");
  applyTheme(theme === "light");
}

function applyTheme(isLight: boolean): void {
  document.documentElement.classList.toggle("light-mode", isLight);
  updateThemeIcon(isLight);
}

function updateThemeIcon(isLight: boolean): void {
  const icon = document.getElementById("theme-icon");
  if (!icon) return;
  if (isLight) {
    icon.innerHTML = `<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"></path>`;
  } else {
    icon.innerHTML = `
      <circle cx="12" cy="12" r="5"></circle>
      <line x1="12" y1="1" x2="12" y2="3"></line>
      <line x1="12" y1="21" x2="12" y2="23"></line>
      <line x1="4.22" y1="4.22" x2="5.64" y2="5.64"></line>
      <line x1="18.36" y1="18.36" x2="19.78" y2="19.78"></line>
      <line x1="1" y1="12" x2="3" y2="12"></line>
      <line x1="21" y1="12" x2="23" y2="12"></line>
      <line x1="4.22" y1="19.78" x2="5.64" y2="18.36"></line>
      <line x1="18.36" y1="5.64" x2="19.78" y2="4.22"></line>`;
  }
}

async function toggleTheme(): Promise<void> {
  const isLight = document.documentElement.classList.contains("light-mode");
  await ChromeStorage.set("theme", isLight ? "dark" : "light");
  applyTheme(!isLight);
}

// ─────────────────────────────────────────────
// Section: Download Settings View
// ─────────────────────────────────────────────

async function loadDownloadSettings(): Promise<void> {
  const config = await loadSettings();

  const maxInput = document.getElementById("max-concurrent") as HTMLInputElement;
  const timeoutInput = document.getElementById("ffmpeg-timeout") as HTMLInputElement;

  maxInput.value = config.maxConcurrent.toString();
  timeoutInput.value = Math.round(config.ffmpegTimeout / 1000).toString();

  document
    .getElementById("save-download-settings")
    ?.addEventListener("click", saveDownloadSettings);
}

async function saveDownloadSettings(): Promise<void> {
  const btn = document.getElementById("save-download-settings") as HTMLButtonElement;
  const maxInput = document.getElementById("max-concurrent") as HTMLInputElement;
  const timeoutInput = document.getElementById("ffmpeg-timeout") as HTMLInputElement;

  btn.disabled = true;
  btn.textContent = "Saving…";

  try {
    const config = (await ChromeStorage.get<StorageConfig>(STORAGE_CONFIG_KEY)) ?? {};
    const timeoutSeconds = parseInt(timeoutInput.value) || DEFAULT_FFMPEG_TIMEOUT_S;
    config.ffmpegTimeout =
      Math.max(MIN_FFMPEG_TIMEOUT_S, Math.min(MAX_FFMPEG_TIMEOUT_S, timeoutSeconds)) * 1000;
    config.maxConcurrent = parseInt(maxInput.value) || DEFAULT_MAX_CONCURRENT;
    await ChromeStorage.set(STORAGE_CONFIG_KEY, config);

    showStatus("Settings saved.", "success");
  } catch (err) {
    showStatus(`Save failed: ${errorMsg(err)}`, "error");
  } finally {
    btn.disabled = false;
    btn.textContent = "Save Settings";
  }
}

// ─────────────────────────────────────────────
// Section: Cloud Providers View
// ─────────────────────────────────────────────

let cloudTabsInitialized = false;

function setupCloudProviderTabs(): void {
  if (cloudTabsInitialized) return;
  cloudTabsInitialized = true;

  document.querySelectorAll<HTMLButtonElement>(".provider-tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      const provider = tab.dataset.provider;
      if (!provider) return;

      document
        .querySelectorAll(".provider-tab")
        .forEach((t) => t.classList.remove("active"));
      document
        .querySelectorAll(".provider-panel")
        .forEach((p) => p.classList.remove("active"));

      tab.classList.add("active");
      document.getElementById(`provider-${provider}`)?.classList.add("active");
    });
  });
}

// -- Google Drive --

async function loadDriveSettings(): Promise<void> {
  const config = await loadSettings();

  const enabledCb = document.getElementById("drive-enabled") as HTMLInputElement;
  const folderNameIn = document.getElementById("drive-folder-name") as HTMLInputElement;
  const folderIdIn = document.getElementById("drive-folder-id") as HTMLInputElement;

  enabledCb.checked = config.googleDrive.enabled;
  folderNameIn.value = config.googleDrive.folderName;
  folderIdIn.value = config.googleDrive.targetFolderId ?? "";

  const driveSettingsEl = document.getElementById("drive-settings");
  if (driveSettingsEl)
    driveSettingsEl.style.display = enabledCb.checked ? "block" : "none";

  enabledCb.addEventListener("change", () => {
    if (driveSettingsEl)
      driveSettingsEl.style.display = enabledCb.checked ? "block" : "none";
  });

  await checkAuthStatus();

  document.getElementById("auth-btn")?.addEventListener("click", handleAuth);
  document.getElementById("sign-out-btn")?.addEventListener("click", handleSignOut);
  document
    .getElementById("save-drive-settings")
    ?.addEventListener("click", saveDriveSettings);
}

async function checkAuthStatus(): Promise<void> {
  const isAuth = await GoogleAuth.isAuthenticated();
  const statusEl = document.getElementById("auth-status") as HTMLSpanElement;
  const authBtn = document.getElementById("auth-btn") as HTMLButtonElement;
  const signOutBtn = document.getElementById("sign-out-btn") as HTMLButtonElement;

  if (isAuth) {
    statusEl.textContent = "Authenticated";
    statusEl.className = "auth-status authenticated";
    authBtn.style.display = "none";
    signOutBtn.style.display = "inline-flex";
  } else {
    statusEl.textContent = "Not Authenticated";
    statusEl.className = "auth-status not-authenticated";
    authBtn.style.display = "inline-flex";
    signOutBtn.style.display = "none";
  }
}

async function handleAuth(): Promise<void> {
  const btn = document.getElementById("auth-btn") as HTMLButtonElement;
  btn.disabled = true;
  btn.textContent = "Authenticating…";
  try {
    await GoogleAuth.authenticate(GOOGLE_DRIVE_SCOPES);
    showStatus("Authenticated with Google.", "success");
    await checkAuthStatus();
  } catch (err) {
    showStatus(`Authentication failed: ${errorMsg(err)}`, "error");
  } finally {
    btn.disabled = false;
    btn.textContent = "Sign in with Google";
  }
}

async function handleSignOut(): Promise<void> {
  try {
    await GoogleAuth.signOut();
    showStatus("Signed out.", "success");
    await checkAuthStatus();
  } catch (err) {
    showStatus(`Sign out failed: ${errorMsg(err)}`, "error");
  }
}

async function saveDriveSettings(): Promise<void> {
  const btn = document.getElementById("save-drive-settings") as HTMLButtonElement;
  btn.disabled = true;
  btn.textContent = "Saving…";

  try {
    const enabledCb = document.getElementById("drive-enabled") as HTMLInputElement;
    const folderNameIn = document.getElementById("drive-folder-name") as HTMLInputElement;
    const folderIdIn = document.getElementById("drive-folder-id") as HTMLInputElement;

    const config = (await ChromeStorage.get<StorageConfig>(STORAGE_CONFIG_KEY)) ?? {};
    config.googleDrive = {
      enabled: enabledCb.checked,
      folderName: folderNameIn.value || DEFAULT_GOOGLE_DRIVE_FOLDER_NAME,
      targetFolderId: folderIdIn.value || undefined,
      createFolderIfNotExists: true,
    };
    await ChromeStorage.set(STORAGE_CONFIG_KEY, config);
    showStatus("Settings saved.", "success");
  } catch (err) {
    showStatus(`Save failed: ${errorMsg(err)}`, "error");
  } finally {
    btn.disabled = false;
    btn.textContent = "Save Settings";
  }
}

// -- S3 --

async function loadS3Settings(): Promise<void> {
  const { s3 } = await loadSettings();

  const get = (id: string) => document.getElementById(id) as HTMLInputElement;

  get("s3-enabled").checked = s3.enabled;
  get("s3-bucket").value = s3.bucket ?? "";
  get("s3-region").value = s3.region ?? "";
  get("s3-endpoint").value = s3.endpoint ?? "";
  get("s3-access-key").value = s3.accessKeyId ?? "";
  get("s3-secret-key").value = s3.secretAccessKey ?? "";
  get("s3-prefix").value = s3.prefix ?? "";

  document.getElementById("save-s3-settings")?.addEventListener("click", saveS3Settings);
}

async function saveS3Settings(): Promise<void> {
  const btn = document.getElementById("save-s3-settings") as HTMLButtonElement;
  btn.disabled = true;
  btn.textContent = "Saving…";

  try {
    const get = (id: string) =>
      (document.getElementById(id) as HTMLInputElement).value.trim();
    const checked = (id: string) =>
      (document.getElementById(id) as HTMLInputElement).checked;

    const config = (await ChromeStorage.get<StorageConfig>(STORAGE_CONFIG_KEY)) ?? {};
    config.s3 = {
      enabled: checked("s3-enabled"),
      bucket: get("s3-bucket") || undefined,
      region: get("s3-region") || undefined,
      endpoint: get("s3-endpoint") || undefined,
      accessKeyId: get("s3-access-key") || undefined,
      secretAccessKey: get("s3-secret-key") || undefined,
      prefix: get("s3-prefix") || undefined,
    };
    await ChromeStorage.set(STORAGE_CONFIG_KEY, config);
    showStatus("Settings saved.", "success");
  } catch (err) {
    showStatus(`Save failed: ${errorMsg(err)}`, "error");
  } finally {
    btn.disabled = false;
    btn.textContent = "Save Settings";
  }
}

// ─────────────────────────────────────────────
// Section: History View
// ─────────────────────────────────────────────

const PAGE_SIZE = 50;
let allHistory: DownloadState[] = [];
const selectedIds = new Set<string>();
let currentFiltered: DownloadState[] = [];
let currentPage = 0;
let historyObserver: IntersectionObserver | null = null;
let historySentinel: HTMLElement | null = null;
let historyMessageListener: ((msg: unknown) => void) | null = null;

function isProgressMsg(
  msg: unknown,
): msg is { type: MessageType.DOWNLOAD_PROGRESS; payload: { id: string; progress: { stage: string } } } {
  return (
    typeof msg === "object" &&
    msg !== null &&
    (msg as { type?: unknown }).type === MessageType.DOWNLOAD_PROGRESS &&
    typeof (msg as { payload?: { id?: unknown } }).payload?.id === "string"
  );
}

function registerHistoryListener(): void {
  if (historyMessageListener) return;
  historyMessageListener = (msg) => {
    if (!isProgressMsg(msg)) return;
    if (!FINISHED_STAGES.has(msg.payload.progress.stage as DownloadStage)) return;
    handleFinishedDownload(msg.payload.id);
  };
  chrome.runtime.onMessage.addListener(historyMessageListener);
}

function unregisterHistoryListener(): void {
  if (!historyMessageListener) return;
  chrome.runtime.onMessage.removeListener(historyMessageListener);
  historyMessageListener = null;
}

async function handleFinishedDownload(id: string): Promise<void> {
  const state = await getDownload(id);
  if (!state) return;

  const idx = allHistory.findIndex((d) => d.id === id);
  if (idx !== -1) {
    allHistory[idx] = state;
  } else {
    allHistory.unshift(state);
  }

  const list = document.getElementById("history-list");
  if (!list) return;

  const existing = list.querySelector<HTMLElement>(`[data-id="${id}"]`);
  if (existing) {
    const el = renderHistoryItem(state);
    flashItem(el);
    list.replaceChild(el, existing);
    return;
  }

  currentFiltered = applyFilters(allHistory);
  currentPage = 0;
  renderHistoryList();
  flashItem(list.querySelector<HTMLElement>(`[data-id="${id}"]`));
}

function flashItem(el: HTMLElement | null): void {
  if (!el) return;
  el.classList.add("history-item--new");
  el.addEventListener("animationend", () => el.classList.remove("history-item--new"), { once: true });
}

async function loadHistory(): Promise<void> {
  const config = await loadSettings();

  const historyEnabledCb = document.getElementById(
    "history-enabled",
  ) as HTMLInputElement;
  historyEnabledCb.checked = config.historyEnabled;

  historyEnabledCb.addEventListener("change", onHistoryEnabledChange);

  // Wire up filter inputs
  document
    .getElementById("history-search")
    ?.addEventListener("input", rerenderHistory);
  document
    .getElementById("filter-format")
    ?.addEventListener("change", rerenderHistory);
  document
    .getElementById("filter-status")
    ?.addEventListener("change", rerenderHistory);
  document
    .getElementById("filter-date")
    ?.addEventListener("change", rerenderHistory);

  // Select all checkbox
  document.getElementById("select-all")?.addEventListener("change", (e) => {
    const checked = (e.target as HTMLInputElement).checked;
    const visible = applyFilters(allHistory);
    if (checked) {
      visible.forEach((d) => selectedIds.add(d.id));
    } else {
      selectedIds.clear();
    }
    syncBulkBar();
    rerenderHistory();
  });

  // Bulk delete
  document.getElementById("bulk-delete")?.addEventListener("click", async () => {
    if (selectedIds.size === 0) return;
    await bulkDeleteDownloads([...selectedIds]);
    allHistory = allHistory.filter((d) => !selectedIds.has(d.id));
    selectedIds.clear();
    syncBulkBar();
    rerenderHistory();
  });

  if (!config.historyEnabled) {
    showHistoryDisabled();
    return;
  }

  registerHistoryListener();
  await fetchAndRenderHistory();
}

async function onHistoryEnabledChange(): Promise<void> {
  const cb = document.getElementById("history-enabled") as HTMLInputElement;
  const enabled = cb.checked;
  const config = (await ChromeStorage.get<StorageConfig>(STORAGE_CONFIG_KEY)) ?? {};
  config.historyEnabled = enabled;
  await ChromeStorage.set(STORAGE_CONFIG_KEY, config);

  if (!enabled) {
    unregisterHistoryListener();
    await clearAllDownloads();
    allHistory = [];
    selectedIds.clear();
    showHistoryDisabled();
  } else {
    registerHistoryListener();
    await fetchAndRenderHistory();
  }
}

async function fetchAndRenderHistory(): Promise<void> {
  const all = await getAllDownloads();
  allHistory = all.filter((d) => FINISHED_STAGES.has(d.progress.stage));
  rerenderHistory();
}

function rerenderHistory(): void {
  currentFiltered = applyFilters(allHistory);
  currentPage = 0;
  renderHistoryList();
}

function applyFilters(all: DownloadState[]): DownloadState[] {
  const searchEl = document.getElementById("history-search") as HTMLInputElement;
  const formatEl = document.getElementById("filter-format") as HTMLSelectElement;
  const statusEl = document.getElementById("filter-status") as HTMLSelectElement;
  const dateEl = document.getElementById("filter-date") as HTMLSelectElement;

  const search = searchEl?.value.toLowerCase() ?? "";
  const format = formatEl?.value ?? "all";
  const status = statusEl?.value ?? "all";
  const date = dateEl?.value ?? "all";

  return all
    .filter(
      (d) =>
        !search ||
        d.metadata.title?.toLowerCase().includes(search) ||
        d.url.toLowerCase().includes(search),
    )
    .filter((d) => format === "all" || d.metadata.format === format)
    .filter((d) => status === "all" || d.progress.stage === status)
    .filter((d) => dateInRange(d.createdAt, date))
    .sort((a, b) => b.createdAt - a.createdAt);
}

function dateInRange(ts: number, range: string): boolean {
  if (range === "all") return true;
  const now = Date.now();
  if (range === "today") return ts >= now - MS_PER_DAY;
  if (range === "week") return ts >= now - 7 * MS_PER_DAY;
  if (range === "month") return ts >= now - 30 * MS_PER_DAY;
  return true;
}

function renderHistoryList(): void {
  const list = document.getElementById("history-list")!;
  const emptyEl = document.getElementById("history-empty")!;
  const disabledEl = document.getElementById("history-disabled")!;

  disconnectHistoryObserver();
  disabledEl.classList.remove("visible");
  list.innerHTML = "";

  if (currentFiltered.length === 0) {
    emptyEl.classList.add("visible");
    return;
  }

  emptyEl.classList.remove("visible");
  currentFiltered.slice(0, PAGE_SIZE).forEach((s) => list.appendChild(renderHistoryItem(s)));
  currentPage = 1;

  if (currentFiltered.length > PAGE_SIZE) {
    setupHistorySentinel();
  }
}

function appendHistoryBatch(): void {
  const list = document.getElementById("history-list")!;
  const start = currentPage * PAGE_SIZE;
  const batch = currentFiltered.slice(start, start + PAGE_SIZE);
  if (batch.length === 0) { disconnectHistoryObserver(); return; }
  batch.forEach((s) => list.appendChild(renderHistoryItem(s)));
  currentPage++;
  if (currentPage * PAGE_SIZE >= currentFiltered.length) disconnectHistoryObserver();
}

function setupHistorySentinel(): void {
  disconnectHistoryObserver();
  historySentinel = document.createElement("div");
  document.getElementById("history-list")!.after(historySentinel);
  const root = document.querySelector<HTMLElement>(".content") ?? null;
  historyObserver = new IntersectionObserver(
    (entries) => { if (entries[0].isIntersecting) appendHistoryBatch(); },
    { root, rootMargin: "120px" },
  );
  historyObserver.observe(historySentinel);
}

function disconnectHistoryObserver(): void {
  historyObserver?.disconnect();
  historyObserver = null;
  historySentinel?.remove();
  historySentinel = null;
}

function showHistoryDisabled(): void {
  disconnectHistoryObserver();
  const list = document.getElementById("history-list")!;
  const emptyEl = document.getElementById("history-empty")!;
  const disabledEl = document.getElementById("history-disabled")!;
  list.innerHTML = "";
  emptyEl.classList.remove("visible");
  disabledEl.classList.add("visible");
}

function renderHistoryItem(state: DownloadState): HTMLElement {
  const item = document.createElement("div");
  item.className = "history-item" + (selectedIds.has(state.id) ? " selected" : "");
  item.dataset.id = state.id;

  // Checkbox
  const cb = document.createElement("input");
  cb.type = "checkbox";
  cb.className = "history-item-checkbox";
  cb.checked = selectedIds.has(state.id);
  cb.addEventListener("change", () => {
    if (cb.checked) selectedIds.add(state.id);
    else selectedIds.delete(state.id);
    item.classList.toggle("selected", cb.checked);
    syncBulkBar();
  });
  item.appendChild(cb);

  // Thumbnail
  const thumbEl = createThumb(state.metadata.thumbnail);
  item.appendChild(thumbEl);

  // Info column
  const info = document.createElement("div");
  info.className = "history-info";

  const title = document.createElement("div");
  title.className = "history-title";
  title.title = state.metadata.title || state.url;
  title.textContent = state.metadata.title || truncateUrl(state.url);
  info.appendChild(title);

  const url = document.createElement("div");
  url.className = "history-url";
  url.title = state.url;
  url.textContent = state.url;
  info.appendChild(url);

  const badges = document.createElement("div");
  badges.className = "history-badges";
  badges.appendChild(makeBadge(state.metadata.format, "badge-format"));
  if (state.metadata.isLive) badges.appendChild(makeBadge("live", "badge-live"));
  if (state.metadata.resolution || state.metadata.quality) {
    badges.appendChild(
      makeBadge((state.metadata.resolution || state.metadata.quality)!, "badge-resolution"),
    );
  }
  badges.appendChild(makeStageBadge(state.progress.stage));
  info.appendChild(badges);

  item.appendChild(info);

  // Actions column
  const actions = document.createElement("div");
  actions.className = "history-actions";

  const date = document.createElement("span");
  date.className = "history-date";
  date.title = new Date(state.createdAt).toLocaleString();
  date.textContent = relativeTime(state.createdAt);
  actions.appendChild(date);

  // Actions menu
  const menuWrap = document.createElement("div");
  menuWrap.className = "history-menu-wrap";

  const menuBtn = document.createElement("button");
  menuBtn.className = "history-menu-btn";
  menuBtn.title = "Actions";
  menuBtn.textContent = "···";

  const menu = document.createElement("div");
  menu.className = "history-menu";

  function closeMenu(): void {
    menu.classList.remove("open");
    document.removeEventListener("click", onOutsideClick);
  }

  function onOutsideClick(e: MouseEvent): void {
    if (!menuWrap.contains(e.target as Node)) closeMenu();
  }

  menuBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    const isOpen = menu.classList.contains("open");
    // Close any other open menus
    document.querySelectorAll(".history-menu.open").forEach((m) => m.classList.remove("open"));
    if (!isOpen) {
      menu.classList.add("open");
      document.addEventListener("click", onOutsideClick);
    }
  });

  function makeMenuItem(svgContent: string, label: string, onClick: () => void, extraClass?: string): HTMLButtonElement {
    const btn = document.createElement("button");
    btn.className = "history-menu-item" + (extraClass ? ` ${extraClass}` : "");
    btn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${svgContent}</svg>${label}`;
    btn.addEventListener("click", () => { closeMenu(); onClick(); });
    return btn;
  }

  // Open file (completed with known path only)
  if (state.progress.stage === DownloadStage.COMPLETED && state.localPath) {
    const localPath = state.localPath;
    menu.appendChild(makeMenuItem(iconFolder(), "Open file", async () => {
      const filename = localPath.split(/[/\\]/).pop();
      if (!filename) return;
      const results = await new Promise<chrome.downloads.DownloadItem[]>((resolve) =>
        chrome.downloads.search({ filenameRegex: filename }, resolve),
      );
      if (results.length > 0) {
        chrome.downloads.show(results[0].id);
      } else {
        chrome.downloads.showDefaultFolder();
      }
    }));
  }

  menu.appendChild(makeMenuItem(iconDownload(), "Re-download", () => redownload(state.url, state.metadata)));
  menu.appendChild(makeMenuItem(iconCopy(), "Copy URL", async () => {
    await navigator.clipboard.writeText(state.url);
    showToast("URL copied to clipboard", "success");
  }));

  menu.appendChild(makeMenuItem(iconLink(), "Check manifest", () => checkManifest(state.url)));

  menu.appendChild(makeMenuItem(iconTrash(), "Delete", async () => {
    await deleteDownload(state.id);
    allHistory = allHistory.filter((d) => d.id !== state.id);
    selectedIds.delete(state.id);
    syncBulkBar();
    rerenderHistory();
  }, "danger"));

  menuWrap.appendChild(menuBtn);
  menuWrap.appendChild(menu);
  actions.appendChild(menuWrap);

  item.appendChild(actions);

  return item;
}

function createThumb(url?: string): HTMLElement {
  if (url) {
    const wrapper = document.createElement("div");
    wrapper.className = "history-thumb";
    const img = document.createElement("img");
    img.src = url;
    img.alt = "";
    img.addEventListener("error", () => {
      wrapper.outerHTML = thumbPlaceholder().outerHTML;
    });
    wrapper.appendChild(img);
    return wrapper;
  }
  return thumbPlaceholder();
}

function thumbPlaceholder(): HTMLElement {
  const el = document.createElement("div");
  el.className = "history-thumb-placeholder";
  el.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2" y="7" width="20" height="15" rx="2"></rect><polyline points="17 2 12 7 7 2"></polyline></svg>`;
  return el;
}

function makeBadge(text: string, cls: string): HTMLElement {
  const b = document.createElement("span");
  b.className = `badge ${cls}`;
  b.textContent = text.toUpperCase();
  return b;
}

function makeStageBadge(stage: DownloadStage): HTMLElement {
  const map: Record<string, string> = {
    [DownloadStage.COMPLETED]: "badge-completed",
    [DownloadStage.FAILED]: "badge-failed",
    [DownloadStage.CANCELLED]: "badge-cancelled",
  };
  return makeBadge(stage, map[stage] ?? "");
}

function makeIconBtn(
  svgContent: string,
  tooltip: string,
  onClick?: () => void,
): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.className = "btn-icon";
  btn.setAttribute("data-tooltip", tooltip);
  btn.setAttribute("aria-label", tooltip);
  btn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${svgContent}</svg>`;
  if (onClick) btn.addEventListener("click", onClick);
  return btn;
}

function syncBulkBar(): void {
  const bar = document.getElementById("bulk-bar")!;
  const count = document.getElementById("bulk-count")!;
  const selectAll = document.getElementById("select-all") as HTMLInputElement;

  bar.classList.toggle("visible", selectedIds.size > 0);
  count.textContent = `${selectedIds.size} selected`;

  const visible = applyFilters(allHistory);
  selectAll.checked = visible.length > 0 && visible.every((d) => selectedIds.has(d.id));
  selectAll.indeterminate =
    !selectAll.checked && visible.some((d) => selectedIds.has(d.id));
}

async function redownload(url: string, metadata?: VideoMetadata): Promise<void> {
  const resolvedMetadata: VideoMetadata = metadata ?? { url, format: "unknown" as any, pageUrl: url };
  const isLive = resolvedMetadata.isLive === true;

  let website: string | undefined;
  try {
    website = new URL(resolvedMetadata.pageUrl ?? url).hostname.replace(/^www\./, "");
  } catch {}

  try {
    const response = await chrome.runtime.sendMessage({
      type: isLive ? MessageType.START_RECORDING : MessageType.DOWNLOAD_REQUEST,
      payload: { url, metadata: resolvedMetadata, tabTitle: metadata?.title, website },
    });
    if (response?.error) return showToast(response.error, "error");
    showToast(isLive ? "Recording started" : "Download queued", "success");
    await fetchAndRenderHistory();
  } catch {
    showToast("Failed to start download", "error");
  }
}

let toastTimer: ReturnType<typeof setTimeout> | null = null;

function showToast(message: string, type: "success" | "error" | "warning"): void {
  const toast = document.getElementById("toast");
  if (!toast) return;

  const icons: Record<string, string> = {
    success: iconCheck(),
    error: iconX(),
    warning: iconQuestion(),
  };

  toast.className = type;
  toast.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${icons[type]}</svg>${message}`;

  if (toastTimer) clearTimeout(toastTimer);
  // Force reflow so the transition triggers even when re-showing
  toast.classList.remove("show");
  void toast.offsetWidth;
  toast.classList.add("show");
  toastTimer = setTimeout(() => toast.classList.remove("show"), TOAST_DURATION_MS);
}

async function checkManifest(url: string): Promise<void> {
  showToast("Checking…", "warning");

  const result = await chrome.runtime.sendMessage({
    type: MessageType.CHECK_URL,
    payload: { url },
  });

  if (!result || result.status === 0) {
    showToast("Manifest unreachable or CORS blocked", "warning");
  } else if (result.ok) {
    showToast("Manifest is live", "success");
  } else {
    showToast(`Manifest returned ${result.status}`, "error");
  }
}

// ─────────────────────────────────────────────
// Section: Utilities
// ─────────────────────────────────────────────

function showStatus(message: string, type: "success" | "error" | "warning" | "info"): void {
  showToast(message, type === "info" ? "warning" : type);
}

function errorMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function truncateUrl(url: string, max = 60): string {
  try {
    const u = new URL(url);
    const host = u.hostname + u.pathname;
    return host.length > max ? host.slice(0, max) + "…" : host;
  } catch {
    return url.length > max ? url.slice(0, max) + "…" : url;
  }
}

function relativeTime(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return "just now";
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < MS_PER_DAY) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / MS_PER_DAY)}d ago`;
}

// ─────────────────────────────────────────────
// SVG icon snippets (inner SVG path strings)
// ─────────────────────────────────────────────

function iconFolder(): string {
  return `<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path>`;
}

function iconDownload(): string {
  return `<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line>`;
}

function iconCopy(): string {
  return `<rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>`;
}

function iconLink(): string {
  return `<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"></path><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"></path>`;
}

function iconTrash(): string {
  return `<polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"></path>`;
}

function iconCheck(): string {
  return `<polyline points="20 6 9 17 4 12"></polyline>`;
}

function iconX(): string {
  return `<line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line>`;
}

function iconQuestion(): string {
  return `<circle cx="12" cy="12" r="10"></circle><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"></path><line x1="12" y1="17" x2="12.01" y2="17"></line>`;
}

function iconSpinner(): string {
  // A simple arc that spins via CSS animation
  return `<circle cx="12" cy="12" r="10" stroke-dasharray="31.4" stroke-dashoffset="10"></circle>`;
}

// ─────────────────────────────────────────────
// Section: Recording View
// ─────────────────────────────────────────────

async function loadRecordingSettings(): Promise<void> {
  const { recording } = await loadSettings();

  const get = (id: string) => document.getElementById(id) as HTMLInputElement;

  get("poll-min").value = (recording.minPollIntervalMs / 1000).toString();
  get("poll-max").value = (recording.maxPollIntervalMs / 1000).toString();
  get("poll-fraction").value = recording.pollFraction.toString();

  document
    .getElementById("save-recording-settings")
    ?.addEventListener("click", saveRecordingSettings);
}

async function saveRecordingSettings(): Promise<void> {
  const btn = document.getElementById("save-recording-settings") as HTMLButtonElement;
  btn.disabled = true;
  btn.textContent = "Saving…";

  try {
    const get = (id: string) => document.getElementById(id) as HTMLInputElement;

    const minPollIntervalMs = Math.max(MIN_POLL_MIN_S, Math.min(MAX_POLL_MIN_S, parseFloat(get("poll-min").value) || (DEFAULT_MIN_POLL_MS / 1000))) * 1000;
    const maxPollIntervalMs = Math.max(MIN_POLL_MAX_S, Math.min(MAX_POLL_MAX_S, parseFloat(get("poll-max").value) || (DEFAULT_MAX_POLL_MS / 1000))) * 1000;
    const pollFraction = Math.max(MIN_POLL_FRACTION, Math.min(MAX_POLL_FRACTION, parseFloat(get("poll-fraction").value) || DEFAULT_POLL_FRACTION));

    if (minPollIntervalMs >= maxPollIntervalMs) {
      showStatus("Minimum poll interval must be less than maximum.", "error");
      return;
    }

    const config = (await ChromeStorage.get<StorageConfig>(STORAGE_CONFIG_KEY)) ?? {};
    config.recording = { minPollIntervalMs, maxPollIntervalMs, pollFraction };
    await ChromeStorage.set(STORAGE_CONFIG_KEY, config);
    showStatus("Settings saved.", "success");
  } catch (err) {
    showStatus(`Save failed: ${errorMsg(err)}`, "error");
  } finally {
    btn.disabled = false;
    btn.textContent = "Save Settings";
  }
}

// ─────────────────────────────────────────────
// Section: Notifications View
// ─────────────────────────────────────────────

async function loadNotificationSettings(): Promise<void> {
  const { notifications } = await loadSettings();

  const notifyCb = document.getElementById("notify-on-completion") as HTMLInputElement;
  const autoOpenCb = document.getElementById("auto-open-file") as HTMLInputElement;

  notifyCb.checked = notifications.notifyOnCompletion;
  autoOpenCb.checked = notifications.autoOpenFile;

  document
    .getElementById("save-notification-settings")
    ?.addEventListener("click", saveNotificationSettings);
}

async function saveNotificationSettings(): Promise<void> {
  const btn = document.getElementById("save-notification-settings") as HTMLButtonElement;
  btn.disabled = true;
  btn.textContent = "Saving…";

  try {
    const notifyCb = document.getElementById("notify-on-completion") as HTMLInputElement;
    const autoOpenCb = document.getElementById("auto-open-file") as HTMLInputElement;

    const config = (await ChromeStorage.get<StorageConfig>(STORAGE_CONFIG_KEY)) ?? {};
    config.notifications = {
      notifyOnCompletion: notifyCb.checked,
      autoOpenFile: autoOpenCb.checked,
    };
    await ChromeStorage.set(STORAGE_CONFIG_KEY, config);
    showStatus("Settings saved.", "success");
  } catch (err) {
    showStatus(`Save failed: ${errorMsg(err)}`, "error");
  } finally {
    btn.disabled = false;
    btn.textContent = "Save Settings";
  }
}

// ─────────────────────────────────────────────
// Section: Advanced View
// ─────────────────────────────────────────────

async function loadAdvancedSettings(): Promise<void> {
  const { advanced } = await loadSettings();

  const get = (id: string) => document.getElementById(id) as HTMLInputElement;

  get("max-retries").value = advanced.maxRetries.toString();
  get("retry-delay").value = (advanced.retryDelayMs / 1000).toString();
  get("retry-backoff").value = advanced.retryBackoffFactor.toString();
  get("failure-rate").value = Math.round(advanced.fragmentFailureRate * 100).toString();
  get("detection-cache-size").value = advanced.detectionCacheSize.toString();
  get("master-playlist-cache-size").value = advanced.masterPlaylistCacheSize.toString();
  get("db-sync-interval").value = (advanced.dbSyncIntervalMs / 1000).toString();

  document
    .getElementById("save-advanced-settings")
    ?.addEventListener("click", saveAdvancedSettings);
  document
    .getElementById("reset-advanced-settings")
    ?.addEventListener("click", resetAdvancedSettings);
}

async function saveAdvancedSettings(): Promise<void> {
  const btn = document.getElementById("save-advanced-settings") as HTMLButtonElement;
  btn.disabled = true;
  btn.textContent = "Saving…";

  try {
    const get = (id: string) => document.getElementById(id) as HTMLInputElement;

    const maxRetries = Math.max(MIN_MAX_RETRIES, Math.min(MAX_MAX_RETRIES, parseInt(get("max-retries").value) || DEFAULT_MAX_RETRIES));
    const retryDelayMs = Math.max(MIN_RETRY_DELAY_S, Math.min(MAX_RETRY_DELAY_S, parseFloat(get("retry-delay").value) || (INITIAL_RETRY_DELAY_MS / 1000))) * 1000;
    const retryBackoffFactor = Math.max(MIN_RETRY_BACKOFF_FACTOR, Math.min(MAX_RETRY_BACKOFF_FACTOR, parseFloat(get("retry-backoff").value) || RETRY_BACKOFF_FACTOR));
    const fragmentFailureRate = Math.max(MIN_FAILURE_RATE, Math.min(MAX_FAILURE_RATE, (parseInt(get("failure-rate").value) || Math.round(MAX_FRAGMENT_FAILURE_RATE * 100)) / 100));
    const detectionCacheSize = Math.max(MIN_DETECTION_CACHE_SIZE, Math.min(MAX_DETECTION_CACHE_SIZE, parseInt(get("detection-cache-size").value) || DEFAULT_DETECTION_CACHE_SIZE));
    const masterPlaylistCacheSize = Math.max(MIN_MASTER_PLAYLIST_CACHE_SIZE, Math.min(MAX_MASTER_PLAYLIST_CACHE_SIZE, parseInt(get("master-playlist-cache-size").value) || DEFAULT_MASTER_PLAYLIST_CACHE_SIZE));
    const dbSyncIntervalMs = Math.max(MIN_DB_SYNC_S, Math.min(MAX_DB_SYNC_S, parseFloat(get("db-sync-interval").value) || (DEFAULT_DB_SYNC_INTERVAL_MS / 1000))) * 1000;

    const config = (await ChromeStorage.get<StorageConfig>(STORAGE_CONFIG_KEY)) ?? {};
    config.advanced = {
      maxRetries,
      retryDelayMs,
      retryBackoffFactor,
      fragmentFailureRate,
      detectionCacheSize,
      masterPlaylistCacheSize,
      dbSyncIntervalMs,
    };
    await ChromeStorage.set(STORAGE_CONFIG_KEY, config);
    showStatus("Settings saved.", "success");
  } catch (err) {
    showStatus(`Save failed: ${errorMsg(err)}`, "error");
  } finally {
    btn.disabled = false;
    btn.textContent = "Save Settings";
  }
}

async function resetAdvancedSettings(): Promise<void> {
  const btn = document.getElementById("reset-advanced-settings") as HTMLButtonElement;
  btn.disabled = true;

  try {
    const config = (await ChromeStorage.get<StorageConfig>(STORAGE_CONFIG_KEY)) ?? {};
    delete config.advanced;
    await ChromeStorage.set(STORAGE_CONFIG_KEY, config);

    // Re-render inputs with defaults
    const get = (id: string) => document.getElementById(id) as HTMLInputElement;
    get("max-retries").value = DEFAULT_MAX_RETRIES.toString();
    get("retry-delay").value = (INITIAL_RETRY_DELAY_MS / 1000).toString();
    get("retry-backoff").value = RETRY_BACKOFF_FACTOR.toString();
    get("failure-rate").value = Math.round(MAX_FRAGMENT_FAILURE_RATE * 100).toString();
    get("detection-cache-size").value = DEFAULT_DETECTION_CACHE_SIZE.toString();
    get("master-playlist-cache-size").value = DEFAULT_MASTER_PLAYLIST_CACHE_SIZE.toString();
    get("db-sync-interval").value = (DEFAULT_DB_SYNC_INTERVAL_MS / 1000).toString();

    showStatus("Reset to defaults.", "success");
  } catch (err) {
    showStatus(`Reset failed: ${errorMsg(err)}`, "error");
  } finally {
    btn.disabled = false;
  }
}

// ─────────────────────────────────────────────
// Bootstrap
// ─────────────────────────────────────────────

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
