/**
 * End-to-end test for Media Bridge network detection: loads the built
 * extension (dist/) into Chromium and checks Content-Type based detection,
 * early-request replay and the toolbar badge against a local test server.
 *
 * Usage: npm run build && tests/e2e/generate-media.sh && npm run test:e2e
 * Env:   CHROME_PATH (default /usr/bin/chromium-browser).
 */
import puppeteer from "puppeteer-core";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXT = path.resolve(process.argv[2] || path.join(HERE, "../../dist"));
const WWW = path.join(HERE, "www");
const PORT = 8765;
const BASE = `http://127.0.0.1:${PORT}`;

if (!fs.existsSync(path.join(WWW, "sample.mp4"))) {
  console.error("Test media missing — run tests/e2e/generate-media.sh first");
  process.exit(2);
}

const server = spawn("node", [path.join(HERE, "server.mjs"), WWW, String(PORT)], { stdio: "inherit" });
await new Promise((r) => setTimeout(r, 500));

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PROFILE = path.join(HERE, "profile");
fs.rmSync(PROFILE, { recursive: true, force: true });

const browser = await puppeteer.launch({
  executablePath: process.env.CHROME_PATH || "/usr/bin/chromium-browser",
  userDataDir: PROFILE,
  headless: "new",
  args: [
    `--disable-extensions-except=${EXT}`,
    `--load-extension=${EXT}`,
    "--autoplay-policy=no-user-gesture-required",
    "--no-first-run",
  ],
});

try {
  const swTarget = await browser.waitForTarget(
    (t) => t.type() === "service_worker" && t.url().endsWith("background.js"),
    { timeout: 15000 },
  );
  const extId = new URL(swTarget.url()).host;
  console.log("extension id", extId);

  // An extension page used as a driver (has chrome.* APIs and can message tabs)
  const driver = await browser.newPage();
  await driver.goto(`chrome-extension://${extId}/options/options.html`);
  const ext = (fn, ...args) => driver.evaluate(fn, ...args);

  const tabIdFor = (url) => ext(async (u) => (await chrome.tabs.query({ url: u }))[0]?.id, url);
  const detected = (tabId) =>
    ext(async (id) => {
      const frames = await chrome.webNavigation.getAllFrames({ tabId: id });
      const out = [];
      for (const f of frames) {
        try {
          const r = await chrome.tabs.sendMessage(id, { type: "GET_DETECTED_VIDEOS" }, { frameId: f.frameId });
          out.push(...(r?.videos ?? []));
        } catch {}
      }
      return out;
    }, tabId);

  /** Poll the tab's detections until `pred` matches one (slow machines / CI). */
  const waitForVideo = async (tabId, pred, timeoutMs = 30000) => {
    const end = Date.now() + timeoutMs;
    let videos = [];
    while (Date.now() < end) {
      videos = await detected(tabId);
      const hit = videos.find(pred);
      if (hit) return { hit, videos };
      await sleep(250);
    }
    return { hit: undefined, videos };
  };
  const summary = (videos) => JSON.stringify(videos.map((v) => [v.format, v.url, v.size]));

  // ---- 1. Extension-less HLS endpoint, identified by Content-Type ----
  const hlsPage = await browser.newPage();
  await hlsPage.goto(`${BASE}/hls.html`);
  const hlsTab = await tabIdFor(`${BASE}/hls.html`);
  const hls = await waitForVideo(hlsTab, (v) => v.url.includes("/stream?id=1"));
  check("HLS detected from Content-Type (no .m3u8 in URL)", hls.hit?.format === "hls", summary(hls.videos));
  const badge = await ext((id) => chrome.action.getBadgeText({ tabId: id }), hlsTab);
  check("Toolbar badge shows detected count", badge === "1", `badge="${badge}"`);

  // ---- 2. .m3u8 media playlist still detected by URL (regression for the old URL-only listener) ----
  const m3u8Page = await browser.newPage();
  await m3u8Page.goto(`${BASE}/m3u8.html`);
  const m3u8Tab = await tabIdFor(`${BASE}/m3u8.html`);
  const m3u8 = await waitForVideo(m3u8Tab, (v) => v.url.includes("/hls/media.m3u8"));
  check("Media playlist detected from .m3u8 URL", m3u8.hit?.format === "m3u8", summary(m3u8.videos));

  // ---- 3. Extension-less progressive MP4, requested before the content script is ready → replay ----
  const directPage = await browser.newPage();
  await directPage.goto(`${BASE}/direct.html`);
  const directTab = await tabIdFor(`${BASE}/direct.html`);
  const direct = await waitForVideo(directTab, (v) => v.url.includes("/media/file?id=7"));
  check("Direct MP4 detected from Content-Type (no extension)", direct.hit?.format === "direct", summary(direct.videos));
  check(
    "Direct MP4 size taken from headers",
    direct.hit?.size === fs.statSync(path.join(WWW, "sample.mp4")).size,
    `size=${direct.hit?.size}`,
  );

  // ---- 4. Small media and stream segments are not reported ----
  const noisePage = await browser.newPage();
  await noisePage.goto(`${BASE}/noise.html`);
  const noiseTab = await tabIdFor(`${BASE}/noise.html`);
  await noisePage.waitForFunction(() => window.__done, { timeout: 15000 });
  await sleep(1500);
  const noise = await detected(noiseTab);
  check("Small clips and .ts segments ignored", noise.length === 0, summary(noise));
  const noiseBadge = await ext((id) => chrome.action.getBadgeText({ tabId: id }), noiseTab);
  check("Badge empty when nothing detected", noiseBadge === "", `badge="${noiseBadge}"`);

  // ---- 5. Badge resets on navigation ----
  await hlsPage.goto(`${BASE}/noise.html?nav=1`);
  await hlsPage.waitForFunction(() => window.__done, { timeout: 15000 });
  await sleep(1000);
  const navBadge = await ext((id) => chrome.action.getBadgeText({ tabId: id }), hlsTab);
  check("Badge resets after navigation", navBadge === "", `badge="${navBadge}"`);
} catch (e) {
  console.error(e);
  check("harness", false, String(e));
} finally {
  await browser.close();
  server.kill();
}
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
