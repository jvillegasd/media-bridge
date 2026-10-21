/**
 * End-to-end test for Media Bridge: loads the built extension (dist/) into
 * Chromium and exercises detection, bulk download, stream capture, DRM refusal,
 * the in-page overlay and the FFmpeg mux/save path against a local test server.
 *
 * Usage: npm run build && tests/e2e/generate-media.sh && npm run test:e2e
 * Env:   CHROME_PATH (default /usr/bin/chromium-browser), requires ffprobe.
 */
import puppeteer from "puppeteer-core";
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXT = path.resolve(process.argv[2] || path.join(HERE, "../../dist"));
const WWW = path.join(HERE, "www");
const DL = path.join(HERE, "downloads");
const BASE = "http://127.0.0.1:8765";
fs.rmSync(DL, { recursive: true, force: true });
fs.mkdirSync(DL);

if (!fs.existsSync(path.join(WWW, "sample.mp4"))) {
  console.error("Test media missing — run tests/e2e/generate-media.sh first");
  process.exit(2);
}

const server = spawn("node", [path.join(HERE, "server.mjs"), WWW, "8765"], { stdio: "inherit" });
await new Promise((r) => setTimeout(r, 500));

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PROFILE = path.join(HERE, "profile");
fs.rmSync(PROFILE, { recursive: true, force: true });
fs.mkdirSync(path.join(PROFILE, "Default"), { recursive: true });
fs.writeFileSync(
  path.join(PROFILE, "Default", "Preferences"),
  JSON.stringify({ download: { default_directory: DL, prompt_for_download: false, directory_upgrade: true } }),
);

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

  const swTarget = await browser.waitForTarget((t) => t.type() === "service_worker" && t.url().endsWith("background.js"), { timeout: 15000 });
  const extId = new URL(swTarget.url()).host;
  console.log("extension id", extId);

  // An extension page we use as a driver (has chrome.* APIs and can message tabs/SW)
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

  /** Wait until the tab's top-frame content script answers (slow machines / CI). */
  const waitForContent = async (tabId, timeoutMs = 30000) => {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      const ok = await ext(async (id) => {
        try {
          return !!(await chrome.tabs.sendMessage(id, { type: "CAPTURE_GET_STATUS", payload: { frameId: 0 } }, { frameId: 0 }));
        } catch {
          return false;
        }
      }, tabId);
      if (ok) return;
      await sleep(250);
    }
    throw new Error(`content script not ready in tab ${tabId}`);
  };

  // ---- 1. Extension-less HLS endpoint, identified by Content-Type ----
  const hlsPage = await browser.newPage();
  await hlsPage.goto(`${BASE}/hls.html`);
  await sleep(3000);
  const hlsTab = await tabIdFor(`${BASE}/hls.html`);
  const hlsVideos = await detected(hlsTab);
  const hlsHit = hlsVideos.find((v) => v.url.includes("/stream?id=1"));
  check("HLS detected from Content-Type (no .m3u8 in URL)", !!hlsHit && hlsHit.format === "hls", JSON.stringify(hlsVideos.map((v) => [v.format, v.url])));
  const badge = await ext((id) => chrome.action.getBadgeText({ tabId: id }), hlsTab);
  check("Toolbar badge shows detected count", badge === "1", `badge="${badge}"`);

  // ---- 2. Extension-less progressive MP4 (request happens before content script → replay) ----
  const directPage = await browser.newPage();
  await directPage.goto(`${BASE}/direct.html`);
  await sleep(3000);
  const directTab = await tabIdFor(`${BASE}/direct.html`);
  const directVideos = await detected(directTab);
  const directHit = directVideos.find((v) => v.url.includes("/media/file?id=7"));
  check("Direct MP4 detected from Content-Type (no extension)", !!directHit && directHit.format === "direct", JSON.stringify(directVideos.map((v) => [v.format, v.url, v.size])));
  check("Direct MP4 size taken from headers", directHit?.size === fs.statSync(path.join(WWW, "sample.mp4")).size, `size=${directHit?.size}`);

  // ---- 3. Bulk download (DOWNLOAD_ALL_DETECTED) of the HLS page ----
  await hlsPage.bringToFront();
  const bulk = await ext((id) => chrome.runtime.sendMessage({ type: "DOWNLOAD_ALL_DETECTED", payload: { tabId: id } }), hlsTab);
  check("Download-all started the HLS download", bulk?.started === 1, JSON.stringify(bulk));

  // ---- 4. MSE stream capture ----
  const msePage = await browser.newPage();
  await msePage.goto(`${BASE}/mse.html`);
  await sleep(1500);
  const mseTab = await tabIdFor(`${BASE}/mse.html`);
  await waitForContent(mseTab);
  const startRes = await ext((id) => chrome.tabs.sendMessage(id, { type: "CAPTURE_COMMAND", payload: { action: "start" } }, { frameId: 0 }), mseTab);
  check("Capture armed via popup command", startRes?.success === true, JSON.stringify(startRes));
  await msePage.evaluate(() => { window.__go = true; });
  await msePage.waitForFunction(() => window.__appendDone || window.__appendError, { timeout: 90000 });
  const appendInfo = await msePage.evaluate(() => window.__appendDone || window.__appendError);
  await sleep(1200); // status is throttled
  const status = await ext((id) => chrome.tabs.sendMessage(id, { type: "CAPTURE_GET_STATUS", payload: { frameId: 0 } }, { frameId: 0 }), mseTab);
  const sess = status?.sessions?.[0];
  const vTrack = sess?.tracks.find((t) => t.kind === "video");
  const aTrack = sess?.tracks.find((t) => t.kind === "audio");
  check("Capture saw video+audio SourceBuffers", !!vTrack && !!aTrack, JSON.stringify(status?.sessions));
  check("Duplicate re-append deduped by decode time", vTrack?.segments === appendInfo.video, `segments=${vTrack?.segments} appended(unique)=${appendInfo.video}`);
  check("Not flagged as DRM", sess?.drm === false);

  const saveRes = await ext((id) => chrome.tabs.sendMessage(id, { type: "CAPTURE_COMMAND", payload: { action: "stop-save" } }, { frameId: 0 }), mseTab);
  check("Stop & save handed off to bridge", saveRes?.success === true && !saveRes.error, JSON.stringify(saveRes));

  // ---- 5. DRM (EME) session must be refused ----
  const drmPage = await browser.newPage();
  await drmPage.goto(`${BASE}/mse.html?drm=1`);
  await sleep(1500);
  const drmTab = await tabIdFor(`${BASE}/mse.html?drm=1`);
  await waitForContent(drmTab);
  await ext((id) => chrome.tabs.sendMessage(id, { type: "CAPTURE_COMMAND", payload: { action: "start" } }, { frameId: 0 }), drmTab);
  await drmPage.evaluate(() => { window.__go = true; });
  await drmPage.waitForFunction(() => window.__appendDone || window.__appendError, { timeout: 90000 });
  await sleep(1200);
  const drmStatus = await ext((id) => chrome.tabs.sendMessage(id, { type: "CAPTURE_GET_STATUS", payload: { frameId: 0 } }, { frameId: 0 }), drmTab);
  const drmSess = drmStatus?.sessions?.[0];
  check("EME session flagged as DRM", drmSess?.drm === true, JSON.stringify(drmStatus?.sessions));
  check("No segments retained for DRM session", (drmSess?.bytes ?? 0) === 0, `bytes=${drmSess?.bytes}`);
  const drmSave = await ext((id) => chrome.tabs.sendMessage(id, { type: "CAPTURE_COMMAND", payload: { action: "stop-save" } }, { frameId: 0 }), drmTab);
  check("Saving a DRM session is refused with DRM reason", drmSave?.success === false && /DRM/.test(drmSave?.error || ""), JSON.stringify(drmSave));
  await drmPage.close();

  // ---- 6. In-page overlay button + menu ----
  await directPage.bringToFront();
  await directPage.setViewport({ width: 900, height: 560 });
  await directPage.mouse.move(300, 250);
  await sleep(400);
  await directPage.mouse.move(320, 260);
  await sleep(600);
  const hasHost = await directPage.evaluate(() => !!document.querySelector("media-bridge-overlay"));
  check("Overlay host injected on hover", hasHost);
  // Button sits at the top-right of the 640px video: click it to open the menu
  const vr = await directPage.evaluate(() => { const r = document.querySelector("video").getBoundingClientRect(); return { right: r.right, top: r.top }; });
  await directPage.mouse.click(vr.right - 60, vr.top + 28);
  await sleep(500);
  await directPage.screenshot({ path: path.join(HERE, "overlay.png") });

  // ---- Wait for both downloads to finish ----
  const readStates = () =>
    ext(
      () =>
        new Promise((resolve) => {
          const req = indexedDB.open("media-bridge");
          req.onsuccess = () => {
            const tx = req.result.transaction("downloads", "readonly");
            const all = tx.objectStore("downloads").getAll();
            all.onsuccess = () => resolve(all.result.map((d) => ({ id: d.id, format: d.metadata.format, stage: d.progress.stage, msg: d.progress.message, err: d.progress.error, path: d.localPath })));
          };
        }),
    );
  let states = [];
  for (let i = 0; i < 300; i++) {
    states = await readStates();
    if (states.length >= 2 && states.every((s) => ["completed", "failed", "cancelled"].includes(s.stage))) break;
    await sleep(1000);
  }
  console.log(JSON.stringify(states, null, 2));
  const cap = states.find((s) => s.format === "capture");
  const hls = states.find((s) => s.format === "hls");
  check("HLS download completed", hls?.stage === "completed", hls?.err || hls?.msg);
  check("Capture muxed and saved", cap?.stage === "completed", cap?.err || cap?.msg);

  const probe = (file) => JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration:stream=codec_type,codec_name", "-of", "json", file]).toString());
  for (const s of [hls, cap]) {
    if (s?.stage !== "completed") continue;
    const file = fs.readdirSync(DL).map((f) => path.join(DL, f)).find((f) => path.basename(f) === path.basename(s.path || ""));
    if (!file) { check(`${s.format} file exists in downloads dir`, false, `${s.path} / ${fs.readdirSync(DL)}`); continue; }
    const p = probe(file);
    const kinds = p.streams.map((x) => x.codec_type).sort().join("+");
    const dur = Number(p.format.duration);
    check(`${s.format} file named after page title`, /Test/i.test(path.basename(file)), path.basename(file));
    check(`${s.format} output has audio+video ~12s`, kinds === "audio+video" && dur > 11 && dur < 13.5, `${path.basename(file)} ${kinds} ${dur}s`);
  }
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
