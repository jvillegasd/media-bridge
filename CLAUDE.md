# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Development build with watch mode (rebuilds on file changes)
npm run dev

# Production build (minified, no sourcemaps)
npm run build

# TypeScript type checking only (no emit)
npm run type-check
```

There are no tests in this project. After building, load the `dist/` directory as an unpacked extension in Chrome (`chrome://extensions/` → Developer mode → Load unpacked).

## FFmpeg.wasm Size Limit

All HLS, M3U8, and DASH downloads are processed by **FFmpeg.wasm** running inside the browser. Output files are limited to approximately **2 GB** — files beyond this will exhaust browser memory during the merge stage.

> **Planned**: Migrate FFmpeg.wasm to [mediabunny](https://github.com/nicktindall/mediabunny) for native-speed muxing without the 2 GB constraint.

## Cloud Upload (Planned)

The code infrastructure for Google Drive uploads exists in `src/core/cloud/` (`GoogleAuth`, `GoogleDriveClient`, `UploadManager`) and the `uploadToDrive` flag is plumbed through `DownloadManager`, but **no actual upload is ever triggered** — `this.uploadToDrive` is stored but never used in `download()`. Do not document this as a working feature. Future work will wire this up and add support for additional providers (S3, Dropbox, etc.).

## Architecture

Media Bridge is a Manifest V3 Chrome extension. It has five distinct execution contexts that communicate via `chrome.runtime.sendMessage`:

1. **Service Worker** (`src/service-worker.ts` → `dist/background.js`): The central orchestrator. Handles all download lifecycle management, routes messages from popup/content scripts, maintains download state, and keeps itself alive during long operations using `chrome.runtime.getPlatformInfo()` heartbeats. Intercepts `.m3u8` and `.mpd` network requests via `chrome.webRequest.onCompleted`.

2. **Content Script** (`src/content.ts` → `dist/content.js`): Built separately as IIFE (content scripts cannot use ES modules). Runs on all pages, uses `DetectionManager` to find videos via DOM observation and network request interception, and injects download buttons. Proxies fetch requests through the service worker to bypass CORS.

3. **Offscreen Document** (`src/offscreen/` → `dist/offscreen/`): A hidden page created on demand for FFmpeg.wasm processing. Reads raw segment chunks from IndexedDB, concatenates them, runs FFmpeg to mux into MP4, and returns a blob URL. Communicates with the service worker via messages since it can't use the Chrome downloads API directly. FFmpeg.wasm is single-threaded — all processing calls are serialized through a promise-based `enqueue()` queue to prevent concurrent `ffmpeg.exec()` from corrupting shared WASM state. Intermediate filenames are prefixed with `downloadId` (e.g., `${downloadId}_video.ts`) to avoid collisions in FFmpeg's virtual filesystem.

4. **Popup** (`src/popup/` → `dist/popup/`): Extension action UI — Videos tab (detected videos), Downloads tab (progress), Manifest tab (manual URL input with quality selector).

5. **Options Page** (`src/options/` → `dist/options/`): Full settings UI with sidebar navigation. Sections: Download (FFmpeg timeout, max concurrent), History (completed/failed/cancelled download log with infinite scroll), Google Drive, S3, Recording (HLS poll interval tuning), Notifications, and Advanced (retries, backoff, cache sizes, fragment failure rate, IDB sync interval). All settings changes notify via bottom toast. History button in the popup header opens the options page directly on the `#history` anchor.

### Download Flow

For HLS/M3U8 downloads:
1. Service worker creates a `DownloadManager`, which delegates to `HlsDownloadHandler` or `M3u8DownloadHandler`
2. Handler parses the playlist, downloads segments concurrently (up to `maxConcurrent`, default 3), stores raw chunks in IndexedDB (`core/database/chunks.ts`)
3. Handler sends `OFFSCREEN_PROCESS_HLS` or `OFFSCREEN_PROCESS_M3U8` message to offscreen document
4. Offscreen document enqueues the job — if another FFmpeg job is running, it waits. Once dequeued, it concatenates chunks from IndexedDB, runs FFmpeg, and returns a blob URL
5. Service worker triggers Chrome download from the blob URL and saves the MP4

For DASH downloads: same flow but via `DashDownloadHandler` and `OFFSCREEN_PROCESS_DASH`. No `-bsf:a aac_adtstoasc` bitstream filter (DASH segments are already ISOBMF). Intermediate files use `.mp4` extension instead of `.ts`.

For direct downloads: the service worker uses `chrome.downloads.download()` directly — no FFmpeg.

For live recording (HLS or DASH): the recording handler polls the media playlist/MPD at the stream's native interval (derived from `#EXT-X-TARGETDURATION` for HLS, `minimumUpdatePeriod` for DASH), collecting new segments as they appear. Aborting triggers the merge phase rather than a discard.

### State Persistence

Download state is persisted in **IndexedDB** (not `chrome.storage`), in the `media-bridge` database (version 3) with two object stores:
- `downloads`: Full `DownloadState` objects keyed by `id`
- `chunks`: Raw `Uint8Array` segments keyed by `[downloadId, index]`

Configuration lives in `chrome.storage.local` under the `storage_config` key (`StorageConfig` type). Always access config through `loadSettings()` (`core/storage/settings.ts`) which returns a fully-typed `AppSettings` object with all defaults applied — never read `StorageConfig` directly. `AppSettings` covers: `ffmpegTimeout`, `maxConcurrent`, `historyEnabled`, `googleDrive`, `s3`, `recording`, `notifications`, and `advanced`.

IndexedDB is used as the shared state store because the five execution contexts don't share memory. The service worker writes state via `storeDownload()` (`core/database/downloads.ts`), which is a single IDB `put` upsert keyed by `id`. The popup reads the full list via `getAllDownloads()` on open. The offscreen document reads raw chunks from the `chunks` store during FFmpeg processing. `chrome.storage` is only used for config because it has a 10 MB quota and can't store `ArrayBuffer`.

Progress updates use two complementary channels:
- **IndexedDB** — durable source of truth; survives popup close/reopen and service worker restarts. Popup reads this on mount.
- **`chrome.runtime.sendMessage` (`DOWNLOAD_PROGRESS`)** — low-latency live updates broadcast by the service worker while the popup is open. Fire-and-forget; missed if popup is closed.

### Progress Update Design (BasePlaylistHandler)

`updateProgress()` (`core/downloader/base-playlist-handler.ts`) is the hot-path progress method called after every segment download. It uses two optimizations to avoid overwhelming the service worker event loop:

1. **`cachedState`** — a class field holding the `DownloadState` object read from IDB on the first call. Every subsequent call mutates this same in-memory object directly (updating `downloaded`, `total`, `percentage`, `speed`, etc.) — zero DB reads. The cache is invalidated (`cachedState = null`) only on `resetDownloadState()` (new download) and `updateStage()` (stage transition), which forces a fresh IDB read to pick up any external changes.

2. **`DB_SYNC_INTERVAL_MS = 500ms` throttle** — `storeDownload()` is only called if at least 500ms have elapsed since the last write. The popup still receives every update via `notifyProgress()` (which fires unconditionally), but IDB writes are capped at ~2/second regardless of segment download frequency.

`updateStage()` bypasses both optimizations — it always does a full IDB read + write because stage transitions are rare and need to reflect the true persisted state.

`HlsRecordingHandler.updateRecordingProgress()` and `DashRecordingHandler.updateRecordingProgress()` also always do a full IDB read + write, but are naturally rate-limited to once per poll cycle (every 1–10 seconds).

**Do not add `getDownload()` calls inside `updateProgress()` or the `onProgress` callback** — that was the root cause of the UI freezing bug fixed in commit `9f2a21e`. With 3 concurrent downloads each firing per segment, even one extra IDB read per callback produces dozens of blocking reads per second that queue up behind user interaction messages in the service worker event loop.

### Message Protocol

All inter-component communication uses the `MessageType` enum in `src/shared/messages.ts`. When adding new message types, add them to this enum and handle them in the service worker's `onMessage` listener switch statement. `CHECK_URL` is used by the options page manifest-check feature to probe a URL's content-type via the service worker (bypassing CORS).

### Build System

The Vite config (`vite.config.ts`) has two important quirks:
- **Content script** is built in a separate Vite sub-build (IIFE format, `inlineDynamicImports: true`) triggered by the `build-content-script-as-iife` plugin. This avoids ES module restrictions for content scripts.
- **HTML files** are post-processed by the `move-html-files` plugin to fix script src paths from absolute to relative after Vite moves them.

FFmpeg WASM files are served from `public/ffmpeg/` and copied to `dist/ffmpeg/` at build time. They are explicitly excluded from Vite's dependency optimization.

### Path Alias

`@` resolves to `src/`. Use `@/core/types` instead of relative paths when importing from deep nesting.

### Format Detection

`VideoFormat` is a string enum (`VideoFormat.DIRECT | HLS | M3U8 | DASH | UNKNOWN`). The distinctions matter:
- `HLS` — master playlist with `#EXT-X-STREAM-INF` quality variants → `HlsDownloadHandler`
- `M3U8` — direct media playlist with segments → `M3u8DownloadHandler`
- `DASH` — MPEG-DASH `.mpd` manifest → `DashDownloadHandler`

Use enum values everywhere; the underlying strings are lowercase for IndexedDB backward compatibility.

### Live Stream Recording

Both HLS and DASH support live recording via `HlsRecordingHandler` and `DashRecordingHandler`, which extend the shared `BaseRecordingHandler`. The recording handler polls the media playlist/MPD at a fixed interval, downloads new segments as they appear, and merges them into an MP4 when the user stops recording or the stream ends naturally (`#EXT-X-ENDLIST` for HLS; `type="dynamic"` → `type="static"` transition for DASH). Controlled via `AbortSignal` — aborting triggers the merge phase, not a discard. The popup UI shows a REC button (only for live streams) and a dedicated `RECORDING` stage with segment count.

### Header Injection (declarativeNetRequest)

`Origin` and `Referer` are **forbidden headers** — browsers silently strip them from `fetch()` calls, even in service worker context. CDNs that require these headers will 404 without them.

The fix uses `chrome.declarativeNetRequest` dynamic rules (`src/core/downloader/header-rules.ts`) to inject these headers at the network layer. Rules are scoped to the specific CDN path prefix and `initiatorDomains: [chrome.runtime.id]` so they only affect extension requests. Each download handler calls `addHeaderRules()` before downloading and `removeHeaderRules()` in its `finally` block. **Do not** attempt to set `Origin`/`Referer` via `fetch()` headers — it won't work.

### Stop & Save (Partial Downloads)

HLS, M3U8, and DASH handlers support saving partial downloads when cancelled. If `shouldSaveOnCancel()` returns true, the handler transitions to the `MERGING` stage with whatever chunks were collected, runs FFmpeg, and saves a partial MP4. The abort signal is cleared before FFmpeg processing to prevent immediate rejection.

### Constants Ownership

- `src/shared/constants.ts` — only constants used across **multiple** modules (runtime defaults, pipeline values, storage keys)
- `src/options/constants.ts` — constants used exclusively within the options UI (toast duration, UI bounds for all settings inputs in seconds, validation clamp values)

**Time representation**: All runtime/storage values use **milliseconds** (`StorageConfig`, `AppSettings`, all handlers). The options UI uses **seconds** exclusively. Conversion happens only in `options.ts`: divide by 1000 on load, multiply by 1000 on save.

### Options Page Field Validation

All numeric inputs are validated **before** saving via three helpers in `options.ts`:

- `validateField(input, min, max, isInteger?)` — parses the value, returns the number on success or `null` on failure. Calls `markInvalid` automatically.
- `markInvalid(input, message)` — adds `.invalid` class (red border) and inserts a `.form-error` div after the input. Registers a one-time `input` listener to auto-clear when the user edits.
- `clearInvalid(input)` — removes `.invalid` and the `.form-error` div.

Each save handler validates all fields upfront and returns early if any are invalid — the button is never disabled and no write is attempted. Cross-field constraints (e.g. `pollMin < pollMax`) call `markInvalid` on the relevant field directly rather than relying on the toast. The toast is reserved for storage/network errors.

### History

Completed, failed, and cancelled downloads are persisted in IndexedDB when `historyEnabled` (default `true`) is set. The options page History section renders all finished downloads with infinite scroll (`IntersectionObserver`). From history, users can re-download (reuses stored metadata for filename), copy the original URL, or delete entries. `bulkDeleteDownloads()` (`core/database/downloads.ts`) handles batch removal. The popup "History" button navigates to `options.html#history`.

### Post-Download Actions

After a download completes, `handlePostDownloadActions()` in the service worker reads `AppSettings.notifications` and optionally fires an OS notification (`notifyOnCompletion`) or opens the file in Finder/Explorer (`autoOpenFile`).

### DASH-Specific Notes

- No `-bsf:a aac_adtstoasc` bitstream filter — DASH segments are already in ISOBMF container format
- Intermediate files use `.mp4` extension (not `.ts`)
- Live detection: `type="dynamic"` attribute in the MPD root element
- Poll interval: `minimumUpdatePeriod` attribute in the MPD
- DRM detection: presence of `<ContentProtection>` elements in any `AdaptationSet`
- mpd-parser v1.3.1 is used; type declarations are in `src/types/mpd-parser.d.ts` (no `@types` package available)

### Project Structure

```
src/
├── service-worker.ts              # Central orchestrator
├── content.ts                     # Content script (IIFE)
├── shared/
│   ├── messages.ts                # MessageType enum
│   └── constants.ts               # DEFAULT_MAX_CONCURRENT, DEFAULT_FFMPEG_TIMEOUT_MS, etc.
├── core/
│   ├── types/
│   │   └── index.ts               # VideoFormat, DownloadState, DownloadStage, Fragment, Level
│   ├── detection/
│   │   ├── detection-manager.ts
│   │   ├── thumbnail-utils.ts
│   │   ├── direct/direct-detection-handler.ts
│   │   ├── hls/hls-detection-handler.ts
│   │   └── dash/dash-detection-handler.ts
│   ├── downloader/
│   │   ├── download-manager.ts
│   │   ├── base-playlist-handler.ts     # Hot-path progress, cachedState, 500ms throttle
│   │   ├── base-recording-handler.ts    # Shared polling loop for live streams
│   │   ├── concurrent-workers.ts
│   │   ├── crypto-utils.ts              # AES-128 decryption
│   │   ├── header-rules.ts              # DNR Origin/Referer injection
│   │   ├── types.ts
│   │   ├── direct/direct-download-handler.ts
│   │   ├── hls/hls-download-handler.ts
│   │   ├── hls/hls-recording-handler.ts
│   │   ├── m3u8/m3u8-download-handler.ts
│   │   ├── dash/dash-download-handler.ts
│   │   └── dash/dash-recording-handler.ts
│   ├── parsers/
│   │   ├── m3u8-parser.ts               # HLS parsing (wraps m3u8-parser)
│   │   ├── mpd-parser.ts                # DASH parsing (wraps mpd-parser)
│   │   └── playlist-utils.ts            # ParsedPlaylist, ParsedSegment, parseLevelsPlaylist()
│   ├── ffmpeg/
│   │   ├── ffmpeg-bridge.ts
│   │   ├── ffmpeg-singleton.ts
│   │   └── offscreen-manager.ts
│   ├── database/
│   │   ├── connection.ts                # IDB init (media-bridge v3)
│   │   ├── downloads.ts                 # storeDownload(), getDownload(), etc.
│   │   └── chunks.ts                    # storeChunk(), deleteChunks(), getChunkCount()
│   ├── storage/
│   │   ├── chrome-storage.ts
│   │   └── settings.ts          # AppSettings interface + loadSettings() — always use this
│   ├── cloud/                           # ⚠️ Planned — not wired up yet
│   │   ├── google-auth.ts
│   │   ├── google-drive.ts
│   │   └── upload-manager.ts
│   ├── metadata/
│   │   └── metadata-extractor.ts
│   └── utils/
│       ├── blob-utils.ts
│       ├── cancellation.ts
│       ├── download-utils.ts
│       ├── drm-utils.ts
│       ├── errors.ts                    # MediaBridgeError hierarchy
│       ├── fetch-utils.ts
│       ├── file-utils.ts
│       ├── format-utils.ts
│       ├── id-utils.ts
│       ├── logger.ts
│       └── url-utils.ts
├── popup/
│   ├── popup.ts / popup.html
│   ├── state.ts
│   ├── tabs.ts
│   ├── render-downloads.ts
│   ├── render-videos.ts
│   ├── render-manifest.ts
│   ├── download-actions.ts
│   └── utils.ts
├── options/
│   ├── options.ts / options.html
│   └── constants.ts             # Options-page-only constants (UI bounds, toast duration)
├── offscreen/
│   ├── offscreen.ts / offscreen.html
└── types/
    └── mpd-parser.d.ts
```
