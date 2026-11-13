/**
 * End-to-end test for Media Bridge: loads the built extension (dist/) into
 * Chromium and checks Content-Type based detection, early-request replay, the
 * toolbar badge, page actions (overlay, shortcuts, bulk download, sniffing
 * threshold), and MediaSource stream capture (opt-in registration, capture
 * and mux, DRM refusal, and hostile-page / failure-path handling) against a
 * local test server.
 *
 * Usage: npm run build && tests/e2e/generate-media.sh && npm run test:e2e
 * Env:   CHROME_PATH (default /usr/bin/chromium-browser).
 */
import puppeteer from "puppeteer-core";
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXT = path.resolve(process.argv[2] || path.join(HERE, "../../dist"));
const WWW = path.join(HERE, "www");
const PORT = 8765;
const DL = path.join(HERE, "downloads");
fs.rmSync(DL, { recursive: true, force: true });
fs.mkdirSync(DL);
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
fs.mkdirSync(path.join(PROFILE, "Default"), { recursive: true });
fs.writeFileSync(
  path.join(PROFILE, "Default", "Preferences"),
  JSON.stringify({
    download: { default_directory: DL, prompt_for_download: false, directory_upgrade: true },
    // The capture fallback saves video and audio as two downloads from the page
    profile: { default_content_setting_values: { automatic_downloads: 1 } },
  }),
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

  // ================= Page actions (overlay, shortcuts, bulk) =================

  const setConfig = (patch) =>
    ext(async (pt) => {
      const k = "storage_config";
      const c = (await chrome.storage.local.get(k))[k] ?? {};
      Object.assign(c, pt);
      await chrome.storage.local.set({ [k]: c });
    }, patch);
  const hoverVideo = async (page) => {
    await page.bringToFront();
    await page.setViewport({ width: 900, height: 560 });
    const r = await page.evaluate(() => { const b = document.querySelector("video").getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; });
    await page.mouse.move(r.x - 10, r.y - 10);
    await sleep(300);
    await page.mouse.move(r.x, r.y);
    await sleep(600);
    return page.evaluate(() => !!document.querySelector("media-bridge-overlay"));
  };

  // ---- P1. Overlay is off by default ----
  check("Overlay not injected by default", (await hoverVideo(directPage)) === false);

  // ---- P2. Enabling the overlay applies without reload ----
  await setConfig({ ui: { showOverlayButton: true, minDirectSizeKb: 512 } });
  await sleep(500);
  check("Overlay injected on hover once enabled", (await hoverVideo(directPage)) === true);
  await directPage.screenshot({ path: path.join(HERE, "overlay.png") });
  await setConfig({ ui: { showOverlayButton: false, minDirectSizeKb: 512 } });
  await sleep(500);
  check("Overlay removed when disabled again", (await directPage.evaluate(() => !!document.querySelector("media-bridge-overlay"))) === false);

  // ---- P3. Keyboard shortcuts declared ----
  const commands = await ext(() => chrome.commands.getAll());
  check(
    "Shortcuts registered",
    ["_execute_action", "download-best-video", "download-all-videos"].every((n) => commands.some((c) => c.name === n)),
    JSON.stringify(commands.map((c) => [c.name, c.shortcut])),
  );

  // ---- P4. Download all detected (from an extension page) ----
  const bulk = await ext((id) => chrome.runtime.sendMessage({ type: "DOWNLOAD_ALL_DETECTED", payload: { tabId: id } }), directTab);
  check("Download-all started the detected direct video", bulk?.started === 1, JSON.stringify(bulk));

  // ---- P5. Sniffing threshold is configurable ----
  await setConfig({ ui: { showOverlayButton: false, minDirectSizeKb: 4096 } });
  await sleep(500);
  {
    const page = await browser.newPage();
    await page.goto(`${BASE}/direct.html?threshold=1`);
    const tab = await tabIdFor(`${BASE}/direct.html?threshold=1`);
    await sleep(3000);
    const vids = await detected(tab);
    check("Direct media under the configured threshold is ignored", !vids.some((v) => v.url.includes("/media/file?id=7")), summary(vids));
    await page.close();
  }
  await setConfig({ ui: { showOverlayButton: false, minDirectSizeKb: 512 } });

  // ================= Stream capture =================

  const cmd = (tabId, action) =>
    ext((id, a) => chrome.tabs.sendMessage(id, { type: "CAPTURE_COMMAND", payload: { action: a } }, { frameId: 0 }), tabId, action);
  const captureStatus = (tabId) =>
    ext((id) => chrome.tabs.sendMessage(id, { type: "CAPTURE_GET_STATUS", payload: { frameId: 0 } }, { frameId: 0 }), tabId);
  const waitForCaptureClient = async (tabId, timeoutMs = 30000) => {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      if (await captureStatus(tabId).catch(() => null)) return true;
      await sleep(250);
    }
    return false;
  };
  const readDb = () =>
    ext(
      () =>
        new Promise((resolve) => {
          const req = indexedDB.open("media-bridge");
          req.onsuccess = () => {
            const tx = req.result.transaction(["downloads", "chunks"], "readonly");
            const all = tx.objectStore("downloads").getAll();
            const keys = tx.objectStore("chunks").getAllKeys();
            tx.oncomplete = () =>
              resolve({
                downloads: all.result.map((d) => ({ id: d.id, format: d.metadata.format, stage: d.progress.stage, msg: d.progress.message, err: d.progress.error, path: d.localPath })),
                chunkIds: [...new Set(keys.result.map((k) => k[0]))],
              });
          };
        }),
    );
  const openMse = async (query = "") => {
    const page = await browser.newPage();
    const url = `${BASE}/mse.html${query}`;
    await page.goto(url);
    const tabId = await tabIdFor(url);
    return { page, tabId };
  };
  const playMse = async (page) => {
    await page.evaluate(() => { window.__go = true; });
    await page.waitForFunction(() => window.__appendDone || window.__appendError, { timeout: 90000 });
    const info = await page.evaluate(() => window.__appendDone || window.__appendError);
    await sleep(1200); // status is throttled
    return info;
  };

  // ---- 6. Off by default: nothing injected into page worlds ----
  {
    const { page } = await openMse();
    await sleep(500);
    const hook = await page.evaluate(() => !!window.__mediaBridgeCaptureInstalled);
    check("Capture hook not injected while capture is disabled (default)", hook === false);
    const regs = await ext(() => chrome.scripting.getRegisteredContentScripts());
    check("No dynamic content script registered by default", regs.length === 0, JSON.stringify(regs));
    await page.close();
  }

  // ---- 7. Enabling capture registers the MAIN-world hook ----
  await ext(async () => {
    const k = "storage_config";
    const c = (await chrome.storage.local.get(k))[k] ?? {};
    c.capture = { enabled: true, maxMb: 512 };
    await chrome.storage.local.set({ [k]: c });
  });
  let regs = [];
  for (let i = 0; i < 40 && regs.length === 0; i++) {
    regs = await ext(() => chrome.scripting.getRegisteredContentScripts());
    if (!regs.length) await sleep(250);
  }
  check("Enabling capture registers the hook", regs[0]?.world === "MAIN" && regs[0]?.runAt === "document_start", JSON.stringify(regs));

  // ---- 8. Capture, dedupe, hostile page messages, save + mux ----
  const mse = await openMse();
  check("Hook injected after enabling", await mse.page.evaluate(() => !!window.__mediaBridgeCaptureInstalled));
  check("Capture client answers in the tab", await waitForCaptureClient(mse.tabId));

  // Page forges a status with markup and wrong types: must be dropped/coerced
  await mse.page.evaluate(() => {
    window.postMessage({
      channel: "__media_bridge_capture__", dir: "to-content", evt: "status",
      status: {
        armed: "yes", totalBytes: "<b>",
        sessions: [
          { id: '1" onmouseover="alert(1)', tracks: "nope", bytes: "<img src=x>", drm: "no" },
          { id: 7, tracks: [{ kind: "<b>x</b>", mime: { nested: "<i>" }, segments: -4, bytes: 1e300 }], bytes: 10, drm: 1 },
        ],
      },
    }, "*");
  });
  await sleep(300);
  const forged = await captureStatus(mse.tabId);
  check(
    "Forged page status is validated and coerced",
    forged.armed === false && forged.sessions.length === 1 && forged.sessions[0].id === 7 &&
      forged.sessions[0].drm === false && forged.sessions[0].tracks[0].kind === "unknown" &&
      forged.sessions[0].tracks[0].mime === "" && forged.sessions[0].tracks[0].segments === 0 && forged.sessions[0].tracks[0].bytes === 0,
    JSON.stringify(forged),
  );

  // Page tries to drive the bridge with a guessed token: no "ready", nothing written
  const forgedClaim = await mse.page.evaluate(async (extId) => {
    const f = document.createElement("iframe");
    f.src = `chrome-extension://${extId}/capture-bridge/bridge.html`;
    document.body.appendChild(f);
    await new Promise((r) => (f.onload = r));
    const ch = new MessageChannel();
    const got = [];
    ch.port1.onmessage = (e) => got.push(e.data);
    f.contentWindow.postMessage({ channel: "__media_bridge_bridge__", token: crypto.randomUUID(), downloadId: "cap_1_forged" }, "*", [ch.port2]);
    ch.port1.postMessage({ type: "chunk", slot: "video", index: 0, data: new ArrayBuffer(1024) });
    ch.port1.postMessage({ type: "done" });
    await new Promise((r) => setTimeout(r, 2000));
    f.remove();
    return got;
  }, extId);
  check("Bridge ignores a page-forged claim", forgedClaim.length === 0, JSON.stringify(forgedClaim));
  check("Forged claim wrote nothing to IndexedDB", !(await readDb()).chunkIds.includes("cap_1_forged"));

  const startRes = await cmd(mse.tabId, "start");
  check("Capture armed via popup command", startRes?.success === true, JSON.stringify(startRes));
  const appendInfo = await playMse(mse.page);
  const status = await captureStatus(mse.tabId);
  const sess = status?.sessions?.[0];
  const vTrack = sess?.tracks.find((t) => t.kind === "video");
  const aTrack = sess?.tracks.find((t) => t.kind === "audio");
  check("Capture saw video+audio SourceBuffers", !!vTrack && !!aTrack, JSON.stringify(status?.sessions));
  check("Out-of-order duplicate re-append deduped", vTrack?.segments === appendInfo.video, `segments=${vTrack?.segments} unique=${appendInfo.video}`);
  check("Not flagged as DRM", sess?.drm === false);

  const saveRes = await cmd(mse.tabId, "stop-save");
  check("Stop & save handed off to bridge", saveRes?.success === true && !saveRes.error, JSON.stringify(saveRes));

  // ---- 9. Bridge blocked by the page: fallback save, SW state cleaned up ----
  const blocked = await openMse("?blockbridge=1");
  await waitForCaptureClient(blocked.tabId);
  await cmd(blocked.tabId, "start");
  await playMse(blocked.page);
  const t0 = Date.now();
  const blockedRes = await cmd(blocked.tabId, "stop-save");
  check(
    "Bridge failure falls back to raw files and says so",
    blockedRes?.success === true && /Merging failed/.test(blockedRes?.error || ""),
    `${JSON.stringify(blockedRes)} after ${Date.now() - t0}ms`,
  );
  await sleep(1000);
  {
    const db = await readDb();
    const failedCaps = db.downloads.filter((d) => d.format === "capture" && d.stage === "failed");
    const stuck = db.downloads.filter((d) => d.format === "capture" && d.stage === "downloading");
    check("Aborted capture marked failed, not left transferring", failedCaps.length === 1 && stuck.length === 0, JSON.stringify(db.downloads));
    check("Aborted capture left no chunks", !db.chunkIds.some((id) => failedCaps.some((d) => id.startsWith(d.id))), JSON.stringify(db.chunkIds));
  }
  await blocked.page.close();

  // ---- 10. DRM (EME) session must be refused ----
  {
    const drm = await openMse("?drm=1");
    await waitForCaptureClient(drm.tabId);
    await cmd(drm.tabId, "start");
    await playMse(drm.page);
    const st = await captureStatus(drm.tabId);
    const s0 = st?.sessions?.[0];
    check("EME session flagged as DRM", s0?.drm === true, JSON.stringify(st?.sessions));
    check("No segments retained for DRM session", (s0?.bytes ?? 0) === 0, `bytes=${s0?.bytes}`);
    const drmSave = await cmd(drm.tabId, "stop-save");
    check("Saving a DRM session is refused with DRM reason", drmSave?.success === false && /DRM/.test(drmSave?.error || ""), JSON.stringify(drmSave));
    await drm.page.close();
  }

  // ---- 11. Wait for the mux, check output ----
  let capDone;
  for (let i = 0; i < 180; i++) {
    capDone = (await readDb()).downloads.find((d) => d.format === "capture" && d.stage !== "failed");
    if (capDone && ["completed", "failed", "cancelled"].includes(capDone.stage)) break;
    await sleep(1000);
  }
  check("Capture muxed and saved", capDone?.stage === "completed", capDone?.err || capDone?.msg);
  if (capDone?.stage === "completed") {
    const file = path.join(DL, path.basename(capDone.path || ""));
    if (!fs.existsSync(file)) {
      check("Capture file exists in downloads dir", false, `${capDone.path} / ${fs.readdirSync(DL)}`);
    } else {
      const p = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration:stream=codec_type", "-of", "json", file]).toString());
      const kinds = p.streams.map((x) => x.codec_type).sort().join("+");
      const dur = Number(p.format.duration);
      check("Capture output has audio+video ~12s", kinds === "audio+video" && dur > 11 && dur < 13.5, `${path.basename(file)} ${kinds} ${dur}s`);
    }
  }
  const rawFiles = fs.readdirSync(DL).filter((f) => /\((video|audio)\)\.(mp4|m4a)$/.test(f));
  check("Fallback wrote separate video and audio files", rawFiles.length === 2, JSON.stringify(fs.readdirSync(DL)));
  {
    const db = await readDb();
    check("No capture chunks left after completion", !db.chunkIds.some((id) => id.startsWith("cap_")), JSON.stringify(db.chunkIds));
  }

  // ---- 12. Capture interrupted by a restart is cleaned up at startup ----
  await ext(
    () =>
      new Promise((resolve) => {
        const req = indexedDB.open("media-bridge");
        req.onsuccess = () => {
          const tx = req.result.transaction(["downloads", "chunks"], "readwrite");
          const now = Date.now();
          tx.objectStore("downloads").put({
            id: "cap_1_stale", url: "http://x/#media-bridge-capture-cap_1_stale",
            metadata: { url: "http://x/", format: "capture" },
            progress: { url: "http://x/", stage: "downloading", message: "Transferring captured stream…" },
            createdAt: now, updatedAt: now,
          });
          tx.objectStore("chunks").put({ downloadId: "cap_1_stale", index: 0, data: new ArrayBuffer(8) });
          tx.objectStore("chunks").put({ downloadId: "cap_1_stale_a", index: 0, data: new ArrayBuffer(8) });
          tx.oncomplete = () => resolve();
        };
      }),
  );
  // Kill the service worker (in-memory capture state is lost), then wake it
  const cdp = await driver.target().createCDPSession();
  await cdp.send("ServiceWorker.enable");
  await cdp.send("ServiceWorker.stopAllWorkers");
  await sleep(1000);
  const driver2 = driver;
  await driver2.evaluate(() => chrome.runtime.sendMessage({ type: "GET_DOWNLOADS" }).catch(() => {}));
  let staleState;
  for (let i = 0; i < 20; i++) {
    staleState = await driver2.evaluate(
      () =>
        new Promise((resolve) => {
          const req = indexedDB.open("media-bridge");
          req.onsuccess = () => {
            const tx = req.result.transaction(["downloads", "chunks"], "readonly");
            const d = tx.objectStore("downloads").get("cap_1_stale");
            const k = tx.objectStore("chunks").getAllKeys();
            tx.oncomplete = () => resolve({ stage: d.result?.progress.stage, chunks: k.result.filter((x) => String(x[0]).startsWith("cap_1_stale")).length });
          };
        }),
    );
    if (staleState.stage === "failed" && staleState.chunks === 0) break;
    await sleep(250);
  }
  check("Interrupted capture failed and its chunks removed on restart", staleState.stage === "failed" && staleState.chunks === 0, JSON.stringify(staleState));
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
