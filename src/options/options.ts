/**
 * Options page logic
 * Sections: init/routing, download settings, cloud providers, history
 */

import { ChromeStorage } from "../core/storage/chrome-storage";
import { loadSettings } from "../core/storage/settings";
import { SecureStorage } from "../core/storage/secure-storage";
import { GoogleAuth, GOOGLE_DRIVE_SCOPES } from "../core/cloud/google-auth";
import { S3Client } from "../core/cloud/s3-client";
import { StorageConfig, EncryptedBlob, DownloadState, DownloadStage, VideoMetadata } from "../core/types";
import { MessageType, CloudProvider } from "../shared/messages";
import {
  getAllDownloads,
  getDownload,
  deleteDownload,
  bulkDeleteDownloads,
  clearAllDownloads,
} from "../core/database/downloads";
import { storeChunk } from "../core/database/chunks";
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
  DownloadStage.UPLOADING,
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
  const validViews = new Set(["history", "cloud-providers", "recording", "notifications", "advanced", "about"]);
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
  if (viewId === "about") loadAboutSection();
}

// ─────────────────────────────────────────────
// Section: About
// ─────────────────────────────────────────────

function loadAboutSection(): void {
  const el = document.getElementById("about-version");
  if (el) el.textContent = chrome.runtime.getManifest().version;
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

  const maxConcurrent = validateField(maxInput, 1, 10, true);
  const timeoutSeconds = validateField(timeoutInput, MIN_FFMPEG_TIMEOUT_S, MAX_FFMPEG_TIMEOUT_S, true);
  if (maxConcurrent === null || timeoutSeconds === null) return;

  btn.disabled = true;
  btn.textContent = "Saving…";

  try {
    const config = (await ChromeStorage.get<StorageConfig>(STORAGE_CONFIG_KEY)) ?? {};
    config.ffmpegTimeout = timeoutSeconds * 1000;
    config.maxConcurrent = maxConcurrent;
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

let advancedTabsInitialized = false;

function setupAdvancedTabs(): void {
  if (advancedTabsInitialized) return;
  advancedTabsInitialized = true;

  document.querySelectorAll<HTMLButtonElement>(".advanced-tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      const tabId = tab.dataset.tab;
      if (!tabId) return;

      document.querySelectorAll(".advanced-tab").forEach((t) => t.classList.remove("active"));
      document.querySelectorAll(".advanced-panel").forEach((p) => p.classList.remove("active"));

      tab.classList.add("active");
      document.getElementById(`advanced-${tabId}`)?.classList.add("active");
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

const S3_ENDPOINT_PRESETS: Record<string, { endpoint: string; region: string }> = {
  r2: { endpoint: "https://<ACCOUNT_ID>.r2.cloudflarestorage.com", region: "auto" },
  b2: { endpoint: "https://s3.<REGION>.backblazeb2.com", region: "us-west-004" },
  wasabi: { endpoint: "https://s3.<REGION>.wasabisys.com", region: "us-east-1" },
  do: { endpoint: "https://<REGION>.digitaloceanspaces.com", region: "nyc3" },
  minio: { endpoint: "https://your-minio-server.example.com", region: "us-east-1" },
};

async function loadS3Settings(): Promise<void> {
  const { s3 } = await loadSettings();

  const inp = (id: string) => document.getElementById(id) as HTMLInputElement;

  const enabledCb = inp("s3-enabled");
  enabledCb.checked = s3.enabled;

  const s3SettingsEl = document.getElementById("s3-settings");
  if (s3SettingsEl)
    s3SettingsEl.style.display = enabledCb.checked ? "block" : "none";

  enabledCb.addEventListener("change", () => {
    if (s3SettingsEl) s3SettingsEl.style.display = enabledCb.checked ? "block" : "none";
  });

  inp("s3-bucket").value = s3.bucket ?? "";
  inp("s3-region").value = s3.region ?? "";
  inp("s3-endpoint").value = s3.endpoint ?? "";
  inp("s3-access-key").value = s3.accessKeyId ?? "";

  // Show placeholder when secret key is stored encrypted
  if (s3.secretKeyEncrypted) {
    inp("s3-secret-key").value = "";
    inp("s3-secret-key").placeholder = "••••••••  (encrypted — leave blank to keep)";
  } else {
    inp("s3-secret-key").value = s3.secretAccessKey ?? "";
  }

  inp("s3-prefix").value = s3.prefix ?? "";
  inp("s3-passphrase").value = "";
  inp("s3-passphrase-confirm").value = "";

  const confirmGroup = document.getElementById("s3-passphrase-confirm-group") as HTMLElement;
  inp("s3-passphrase").addEventListener("input", () => {
    confirmGroup.style.display = inp("s3-passphrase").value ? "block" : "none";
  });

  // Provider preset selector
  const presetSel = document.getElementById("s3-provider-preset") as HTMLSelectElement;
  if (presetSel) {
    presetSel.addEventListener("change", () => {
      const preset = S3_ENDPOINT_PRESETS[presetSel.value];
      if (preset) {
        inp("s3-endpoint").value = preset.endpoint;
        inp("s3-region").value = preset.region;
      }
    });
  }

  // Render CORS config helper
  const corsEl = document.getElementById("s3-cors-json");
  if (corsEl) {
    const extId = chrome.runtime.id;
    const corsConfig = JSON.stringify([{
      AllowedHeaders: ["*"],
      AllowedMethods: ["PUT", "POST", "HEAD", "DELETE"],
      AllowedOrigins: [`chrome-extension://${extId}`],
      ExposeHeaders: ["ETag"],
    }], null, 2);
    corsEl.textContent = corsConfig;
  }

  document.getElementById("s3-copy-cors")?.addEventListener("click", async () => {
    const text = document.getElementById("s3-cors-json")?.textContent ?? "";
    await navigator.clipboard.writeText(text);
    const btn = document.getElementById("s3-copy-cors") as HTMLButtonElement;
    btn.textContent = "Copied!";
    setTimeout(() => { btn.textContent = "Copy CORS Config"; }, 2000);
  });

  document.getElementById("s3-test-connection")?.addEventListener("click", testS3Connection);
  document.getElementById("save-s3-settings")?.addEventListener("click", saveS3Settings);
}

async function testS3Connection(): Promise<void> {
  const btn = document.getElementById("s3-test-connection") as HTMLButtonElement;
  const resultEl = document.getElementById("s3-test-result") as HTMLSpanElement;
  btn.disabled = true;
  btn.textContent = "Testing…";
  resultEl.textContent = "";
  resultEl.style.color = "";

  try {
    const inp = (id: string) =>
      (document.getElementById(id) as HTMLInputElement).value.trim();

    const bucket = inp("s3-bucket");
    const region = inp("s3-region");
    const accessKeyId = inp("s3-access-key");
    const endpoint = inp("s3-endpoint") || undefined;

    // Resolve secret key: prefer the text field; fall back to decrypting stored blob
    let secretAccessKey = inp("s3-secret-key");
    if (!secretAccessKey) {
      const { s3 } = await loadSettings();
      if (s3.secretKeyEncrypted) {
        let passphrase = await SecureStorage.getPassphrase();
        if (!passphrase) {
          passphrase = window.prompt("Enter your S3 encryption passphrase to test the connection:") ?? "";
          if (!passphrase) {
            resultEl.textContent = "Passphrase required to decrypt the stored secret key.";
            resultEl.style.color = "var(--error)";
            return;
          }
        }
        try {
          secretAccessKey = await SecureStorage.decrypt(s3.secretKeyEncrypted, passphrase);
          await SecureStorage.setPassphrase(passphrase);
        } catch {
          resultEl.textContent = "✗ Wrong passphrase — could not decrypt secret key.";
          resultEl.style.color = "var(--error)";
          return;
        }
      }
    }

    if (!bucket || !region || !accessKeyId || !secretAccessKey) {
      resultEl.textContent = "Fill in bucket, region, and credentials first.";
      resultEl.style.color = "var(--error)";
      return;
    }

    const client = new S3Client({ bucket, region, accessKeyId, secretAccessKey, endpoint });
    const { ok, error } = await client.testConnection();

    if (ok) {
      resultEl.textContent = "✓ Connection successful";
      resultEl.style.color = "var(--success, #22c55e)";
    } else {
      resultEl.textContent = `✗ ${error}`;
      resultEl.style.color = "var(--error)";
    }
  } catch (err) {
    resultEl.textContent = `✗ ${errorMsg(err)}`;
    resultEl.style.color = "var(--error)";
  } finally {
    btn.disabled = false;
    btn.textContent = "Test Connection";
  }
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

    const passphrase = get("s3-passphrase");
    const passphraseConfirm = get("s3-passphrase-confirm");
    const secretKeyRaw = get("s3-secret-key");

    if (passphrase && passphrase !== passphraseConfirm) {
      showStatus("Passphrases do not match.", "error");
      return;
    }

    const config = (await ChromeStorage.get<StorageConfig>(STORAGE_CONFIG_KEY)) ?? {};
    const existing = config.s3;

    // Determine the secret key to store
    let secretAccessKey: string | undefined;
    let secretKeyEncrypted: EncryptedBlob | undefined;

    if (secretKeyRaw) {
      // User typed a (new) secret key
      if (passphrase) {
        secretKeyEncrypted = await SecureStorage.encrypt(secretKeyRaw, passphrase);
        await SecureStorage.setPassphrase(passphrase);
        secretAccessKey = undefined;
      } else {
        secretAccessKey = secretKeyRaw;
        secretKeyEncrypted = undefined;
      }
    } else {
      // Secret key field left blank — keep existing stored value
      secretAccessKey = existing?.secretAccessKey;
      secretKeyEncrypted = existing?.secretKeyEncrypted;
      // If new passphrase provided, re-encrypt the existing plaintext key (migration)
      if (passphrase && secretAccessKey) {
        secretKeyEncrypted = await SecureStorage.encrypt(secretAccessKey, passphrase);
        await SecureStorage.setPassphrase(passphrase);
        secretAccessKey = undefined;
      }
    }

    config.s3 = {
      enabled: checked("s3-enabled"),
      bucket: get("s3-bucket") || undefined,
      region: get("s3-region") || undefined,
      endpoint: get("s3-endpoint") || undefined,
      accessKeyId: get("s3-access-key") || undefined,
      secretAccessKey,
      secretKeyEncrypted,
      prefix: get("s3-prefix") || undefined,
    };
    await ChromeStorage.set(STORAGE_CONFIG_KEY, config);

    // Reload fields so encrypted placeholder appears
    await loadS3Settings();
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
  
  if (state.cloudLinks?.googleDrive || state.cloudLinks?.s3) {
    badges.appendChild(makeBadge("uploaded", "badge-uploaded"));
  }
  
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

  // Upload progress indicator
  if (state.progress.stage === DownloadStage.UPLOADING) {
    const pct = state.progress.percentage || 0;
    const progressEl = document.createElement("div");
    progressEl.className = "history-upload-progress";
    progressEl.title = `Uploading... ${Math.round(pct)}%`;
    progressEl.innerHTML = iconUploadProgress(pct);
    actions.appendChild(progressEl);
  }

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

  // Upload to cloud (completed only)
  if (state.progress.stage === DownloadStage.COMPLETED && !state.metadata.hasDrm) {
    const uploadLabel = state.uploadError ? "Retry upload" : "Upload to cloud";
    menu.appendChild(makeMenuItem(iconUpload(), uploadLabel, () => handleHistoryUpload(state.id)));
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
    [DownloadStage.UPLOADING]: "badge-completed",
  };
  return makeBadge(stage, map[stage] ?? "");
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

async function handleHistoryUpload(downloadId: string): Promise<void> {
  const settings = await loadSettings();
  const driveEnabled = settings.googleDrive?.enabled === true;
  const s3Enabled = settings.s3?.enabled === true;

  if (!driveEnabled && !s3Enabled) {
    showToast("No cloud provider configured. Go to Cloud Providers settings.", "error");
    return;
  }

  let provider: CloudProvider;
  if (driveEnabled && !s3Enabled) {
    provider = "googleDrive";
  } else if (s3Enabled && !driveEnabled) {
    provider = "s3";
  } else {
    // Both configured — ask user
    const choice = await new Promise<CloudProvider | null>((resolve) => {
      const overlay = document.createElement("div");
      overlay.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:9999;display:flex;align-items:center;justify-content:center;";

      const dialog = document.createElement("div");
      dialog.style.cssText = "background:var(--bg-secondary,#1e1e2e);border:1px solid var(--border-color,#3a3a5c);border-radius:8px;padding:20px;min-width:220px;text-align:center;";
      dialog.innerHTML = `<div style="margin-bottom:12px;font-weight:500;color:var(--text-primary,#cdd6f4);">Choose provider</div>`;

      const btnStyle = "display:block;width:100%;padding:8px 12px;margin-top:8px;border:1px solid var(--border-color,#3a3a5c);border-radius:6px;background:var(--bg-primary,#11111b);color:var(--text-primary,#cdd6f4);cursor:pointer;font-size:13px;";

      const driveBtn = document.createElement("button");
      driveBtn.textContent = "Google Drive";
      driveBtn.style.cssText = btnStyle;
      driveBtn.addEventListener("click", () => { overlay.remove(); resolve("googleDrive"); });

      const s3Btn = document.createElement("button");
      s3Btn.textContent = "S3";
      s3Btn.style.cssText = btnStyle;
      s3Btn.addEventListener("click", () => { overlay.remove(); resolve("s3"); });

      overlay.addEventListener("click", (e) => { if (e.target === overlay) { overlay.remove(); resolve(null); } });

      dialog.appendChild(driveBtn);
      dialog.appendChild(s3Btn);
      overlay.appendChild(dialog);
      document.body.appendChild(overlay);
    });
    if (!choice) return;
    provider = choice;
  }

  // Open file picker
  let file: File;
  try {
    const [fileHandle] = await (window as any).showOpenFilePicker({
      multiple: false,
      types: [{ description: "Video files", accept: { "video/*": [".mp4", ".webm", ".mkv", ".mov"] } }],
    });
    file = await fileHandle.getFile();
  } catch (err: any) {
    if (err?.name === "AbortError") return;
    showToast("Failed to select file", "error");
    return;
  }

  if (!file.type.startsWith("video/")) {
    showToast(`Invalid file type "${file.type}". Select a video file.`, "error");
    return;
  }

  showToast("Uploading…", "warning");

  try {
    // Store file bytes in IDB — chrome.runtime.sendMessage uses JSON
    // serialization which destroys ArrayBuffer. IDB is shared across contexts.
    const tempKey = `__upload_${downloadId}`;
    await storeChunk(tempKey, 0, await file.arrayBuffer());

    const response = await new Promise<any>((resolve, reject) => {
      chrome.runtime.sendMessage(
        {
          type: MessageType.UPLOAD_REQUEST,
          payload: { downloadId, provider },
        },
        (res) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
            return;
          }
          resolve(res);
        },
      );
    });
    if (response?.success) {
      showToast("Upload complete", "success");
      await fetchAndRenderHistory();
    } else {
      showToast("Upload failed: " + (response?.error || "Unknown error"), "error");
    }
  } catch (err: any) {
    showToast("Upload failed: " + (err?.message || "Unknown error"), "error");
  }
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

// ─────────────────────────────────────────────
// Section: Field Validation
// ─────────────────────────────────────────────

/**
 * Validate a numeric input against [min, max].
 * Marks the field invalid and shows an inline error if out of range or not a number.
 * Returns the parsed value on success, null on failure.
 */
function validateField(
  input: HTMLInputElement,
  min: number,
  max: number,
  isInteger = false,
): number | null {
  const raw = input.value.trim();
  const val = isInteger ? parseInt(raw, 10) : parseFloat(raw);

  if (isNaN(val) || val < min || val > max) {
    const lo = isInteger ? min : min;
    const hi = isInteger ? max : max;
    markInvalid(
      input,
      isNaN(val)
        ? "Must be a number"
        : `Must be between ${lo} and ${hi}`,
    );
    return null;
  }

  clearInvalid(input);
  return val;
}

function markInvalid(input: HTMLInputElement, message: string): void {
  input.classList.add("invalid");

  // Remove any existing error for this field
  const next = input.nextElementSibling;
  if (next?.classList.contains("form-error")) next.remove();

  const err = document.createElement("div");
  err.className = "form-error";
  err.textContent = message;
  input.insertAdjacentElement("afterend", err);

  // Clear on next user edit
  input.addEventListener(
    "input",
    () => clearInvalid(input),
    { once: true },
  );
}

function clearInvalid(input: HTMLInputElement): void {
  input.classList.remove("invalid");
  const next = input.nextElementSibling;
  if (next?.classList.contains("form-error")) next.remove();
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

function iconUpload(): string {
  return `<path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z"></path><polyline points="16 16 12 12 8 16"></polyline><line x1="12" y1="12" x2="12" y2="20"></line>`;
}

function iconUploadProgress(pct: number): string {
  const radius = 9;
  const circumference = 2 * Math.PI * radius;
  const dashoffset = circumference - (pct / 100) * circumference;

  return `
    <div style="position: relative; width: 24px; height: 24px; display: flex; align-items: center; justify-content: center;">
      <svg width="24" height="24" viewBox="0 0 24 24" style="position: absolute; top: 0; left: 0; transform: rotate(-90deg);">
        <circle cx="12" cy="12" r="${radius}" fill="none" stroke="currentColor" stroke-width="2" stroke-opacity="0.2"></circle>
        <circle cx="12" cy="12" r="${radius}" fill="none" stroke="var(--accent)" stroke-width="2" stroke-dasharray="${circumference}" stroke-dashoffset="${dashoffset}" stroke-linecap="round"></circle>
      </svg>
      <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="color: var(--accent);">
        ${iconUpload()}
      </svg>
    </div>
  `;
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
  const get = (id: string) => document.getElementById(id) as HTMLInputElement;

  const pollMinS = validateField(get("poll-min"), MIN_POLL_MIN_S, MAX_POLL_MIN_S);
  const pollMaxS = validateField(get("poll-max"), MIN_POLL_MAX_S, MAX_POLL_MAX_S);
  const pollFraction = validateField(get("poll-fraction"), MIN_POLL_FRACTION, MAX_POLL_FRACTION);
  if (pollMinS === null || pollMaxS === null || pollFraction === null) return;

  if (pollMinS >= pollMaxS) {
    markInvalid(get("poll-min"), "Must be less than the maximum poll interval");
    return;
  }

  btn.disabled = true;
  btn.textContent = "Saving…";

  try {
    const config = (await ChromeStorage.get<StorageConfig>(STORAGE_CONFIG_KEY)) ?? {};
    config.recording = {
      minPollIntervalMs: pollMinS * 1000,
      maxPollIntervalMs: pollMaxS * 1000,
      pollFraction,
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

  for (const id of ["save-advanced-settings", "save-advanced-settings-caches", "save-advanced-settings-perf"]) {
    document.getElementById(id)?.addEventListener("click", saveAdvancedSettings);
  }
  for (const id of ["reset-advanced-settings", "reset-advanced-settings-caches", "reset-advanced-settings-perf"]) {
    document.getElementById(id)?.addEventListener("click", resetAdvancedSettings);
  }

  setupAdvancedTabs();
}

async function saveAdvancedSettings(event?: Event): Promise<void> {
  const btn = ((event?.currentTarget as HTMLButtonElement | null)
    ?? document.getElementById("save-advanced-settings")) as HTMLButtonElement;
  const get = (id: string) => document.getElementById(id) as HTMLInputElement;

  const maxRetries       = validateField(get("max-retries"),               MIN_MAX_RETRIES,               MAX_MAX_RETRIES,               true);
  const retryDelayS      = validateField(get("retry-delay"),               MIN_RETRY_DELAY_S,             MAX_RETRY_DELAY_S);
  const retryBackoff     = validateField(get("retry-backoff"),             MIN_RETRY_BACKOFF_FACTOR,      MAX_RETRY_BACKOFF_FACTOR);
  const failureRatePct   = validateField(get("failure-rate"),              MIN_FAILURE_RATE * 100,        MAX_FAILURE_RATE * 100,        true);
  const detectionCache   = validateField(get("detection-cache-size"),      MIN_DETECTION_CACHE_SIZE,      MAX_DETECTION_CACHE_SIZE,      true);
  const masterCache      = validateField(get("master-playlist-cache-size"),MIN_MASTER_PLAYLIST_CACHE_SIZE,MAX_MASTER_PLAYLIST_CACHE_SIZE, true);
  const dbSyncS          = validateField(get("db-sync-interval"),          MIN_DB_SYNC_S,                 MAX_DB_SYNC_S);

  if (
    maxRetries === null || retryDelayS === null || retryBackoff === null ||
    failureRatePct === null || detectionCache === null || masterCache === null || dbSyncS === null
  ) return;

  btn.disabled = true;
  btn.textContent = "Saving…";

  try {
    const config = (await ChromeStorage.get<StorageConfig>(STORAGE_CONFIG_KEY)) ?? {};
    config.advanced = {
      maxRetries,
      retryDelayMs:          retryDelayS * 1000,
      retryBackoffFactor:    retryBackoff,
      fragmentFailureRate:   failureRatePct / 100,
      detectionCacheSize:    detectionCache,
      masterPlaylistCacheSize: masterCache,
      dbSyncIntervalMs:      dbSyncS * 1000,
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

async function resetAdvancedSettings(event?: Event): Promise<void> {
  const btn = ((event?.currentTarget as HTMLButtonElement | null)
    ?? document.getElementById("reset-advanced-settings")) as HTMLButtonElement;
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
