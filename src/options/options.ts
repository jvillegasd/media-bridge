/**
 * Options page logic
 */

import { ChromeStorage } from "../core/storage/chrome-storage";
import { GoogleAuth } from "../core/cloud/google-auth";
import { StorageConfig } from "../core/types";

// DOM elements
const driveEnabled = document.getElementById(
  "driveEnabled",
) as HTMLInputElement;
const driveSettings = document.getElementById(
  "driveSettings",
) as HTMLDivElement;
const folderName = document.getElementById("folderName") as HTMLInputElement;
const folderId = document.getElementById("folderId") as HTMLInputElement;
const authStatus = document.getElementById("authStatus") as HTMLSpanElement;
const authBtn = document.getElementById("authBtn") as HTMLButtonElement;
const signOutBtn = document.getElementById("signOutBtn") as HTMLButtonElement;
const maxConcurrent = document.getElementById(
  "maxConcurrent",
) as HTMLInputElement;
const saveBtn = document.getElementById("saveBtn") as HTMLButtonElement;
const statusMessage = document.getElementById(
  "statusMessage",
) as HTMLDivElement;
const themeToggle = document.getElementById("themeToggle") as HTMLButtonElement;
const themeIcon = document.getElementById("themeIcon") as SVGElement;

const CONFIG_KEY = "storage_config";

/**
 * Initialize options page
 */
async function init() {
  await loadSettings();
  await checkAuthStatus();
  await loadTheme();

  // Event listeners
  driveEnabled.addEventListener("change", () => {
    driveSettings.style.display = driveEnabled.checked ? "block" : "none";
  });

  authBtn.addEventListener("click", handleAuth);
  signOutBtn.addEventListener("click", handleSignOut);
  saveBtn.addEventListener("click", handleSave);

  if (themeToggle) {
    themeToggle.addEventListener("click", toggleTheme);
  }

  // Show drive settings if enabled
  if (driveEnabled.checked) {
    driveSettings.style.display = "block";
  }
}

/**
 * Load settings from storage
 */
async function loadSettings() {
  const config = await ChromeStorage.get<StorageConfig>(CONFIG_KEY);

  if (config?.googleDrive) {
    driveEnabled.checked = config.googleDrive.enabled || false;
    folderName.value = config.googleDrive.folderName || "MediaBridge Uploads";
    folderId.value = config.googleDrive.targetFolderId || "";
  }

  const maxConcurrentValue = await ChromeStorage.get<number>("max_concurrent");
  if (maxConcurrentValue) {
    maxConcurrent.value = maxConcurrentValue.toString();
  }
}

/**
 * Check authentication status
 */
async function checkAuthStatus() {
  const isAuth = await GoogleAuth.isAuthenticated();

  if (isAuth) {
    authStatus.textContent = "Authenticated";
    authStatus.className = "auth-status authenticated";
    authBtn.style.display = "none";
    signOutBtn.style.display = "inline-block";
  } else {
    authStatus.textContent = "Not Authenticated";
    authStatus.className = "auth-status not-authenticated";
    authBtn.style.display = "inline-block";
    signOutBtn.style.display = "none";
  }
}

/**
 * Handle authentication
 */
async function handleAuth() {
  authBtn.disabled = true;
  authBtn.textContent = "Authenticating...";

  try {
    const { GOOGLE_DRIVE_SCOPES } = await import("../core/cloud/google-auth");
    await GoogleAuth.authenticate(GOOGLE_DRIVE_SCOPES);

    showStatus("Successfully authenticated with Google!", "success");
    await checkAuthStatus();
  } catch (error) {
    console.error("Authentication failed:", error);
    showStatus(
      `Authentication failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
      "error",
    );
  } finally {
    authBtn.disabled = false;
    authBtn.textContent = "Sign in with Google";
  }
}

/**
 * Handle sign out
 */
async function handleSignOut() {
  try {
    await GoogleAuth.signOut();
    showStatus("Signed out successfully", "success");
    await checkAuthStatus();
  } catch (error) {
    console.error("Sign out failed:", error);
    showStatus(
      `Sign out failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
      "error",
    );
  }
}

/**
 * Handle save
 */
async function handleSave() {
  saveBtn.disabled = true;
  saveBtn.textContent = "Saving...";

  try {
    const config: StorageConfig = {
      googleDrive: {
        enabled: driveEnabled.checked,
        folderName: folderName.value || "MediaBridge Uploads",
        targetFolderId: folderId.value || undefined,
        createFolderIfNotExists: true,
      },
    };

    await ChromeStorage.set(CONFIG_KEY, config);
    await ChromeStorage.set(
      "max_concurrent",
      parseInt(maxConcurrent.value) || 3,
    );

    showStatus("Settings saved successfully!", "success");
  } catch (error) {
    console.error("Save failed:", error);
    showStatus(
      `Failed to save settings: ${
        error instanceof Error ? error.message : String(error)
      }`,
      "error",
    );
  } finally {
    saveBtn.disabled = false;
    saveBtn.textContent = "Save Settings";
  }
}

/**
 * Show status message
 */
function showStatus(message: string, type: "success" | "error" | "info") {
  statusMessage.className = `status status-${type}`;
  statusMessage.textContent = message;
  statusMessage.style.display = "block";

  setTimeout(() => {
    statusMessage.style.display = "none";
  }, 5000);
}

/**
 * Load theme from storage and apply it
 */
async function loadTheme() {
  const theme = await ChromeStorage.get<string>("theme");
  const isLightMode = theme === "light";
  applyTheme(isLightMode);
}

/**
 * Apply theme to the page
 */
function applyTheme(isLightMode: boolean) {
  const root = document.documentElement;
  if (isLightMode) {
    root.classList.add("light-mode");
  } else {
    root.classList.remove("light-mode");
  }
  updateThemeIcon(isLightMode);
}

/**
 * Update theme icon based on current theme
 */
function updateThemeIcon(isLightMode: boolean) {
  if (!themeIcon) return;

  if (isLightMode) {
    // Moon icon for light mode (to switch to dark)
    themeIcon.innerHTML = `
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"></path>
    `;
  } else {
    // Sun icon for dark mode (to switch to light)
    themeIcon.innerHTML = `
      <circle cx="12" cy="12" r="5"></circle>
      <line x1="12" y1="1" x2="12" y2="3"></line>
      <line x1="12" y1="21" x2="12" y2="23"></line>
      <line x1="4.22" y1="4.22" x2="5.64" y2="5.64"></line>
      <line x1="18.36" y1="18.36" x2="19.78" y2="19.78"></line>
      <line x1="1" y1="12" x2="3" y2="12"></line>
      <line x1="21" y1="12" x2="23" y2="12"></line>
      <line x1="4.22" y1="19.78" x2="5.64" y2="18.36"></line>
      <line x1="18.36" y1="5.64" x2="19.78" y2="4.22"></line>
    `;
  }
}

/**
 * Toggle theme between light and dark
 */
async function toggleTheme() {
  const root = document.documentElement;
  const isLightMode = root.classList.contains("light-mode");
  const newTheme = isLightMode ? "dark" : "light";

  await ChromeStorage.set("theme", newTheme);
  applyTheme(!isLightMode);
}

// Initialize when DOM is ready
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
