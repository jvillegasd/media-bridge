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

## Architecture

Media Bridge is a Manifest V3 Chrome extension. It has five distinct execution contexts that communicate via `chrome.runtime.sendMessage`:

1. **Service Worker** (`src/service-worker.ts` → `dist/background.js`): The central orchestrator. Handles all download lifecycle management, routes messages from popup/content scripts, maintains download state, and keeps itself alive during long operations using `chrome.runtime.getPlatformInfo()` heartbeats. Intercepts `.m3u8` network requests via `chrome.webRequest.onCompleted`.

2. **Content Script** (`src/content.ts` → `dist/content.js`): Built separately as IIFE (content scripts cannot use ES modules). Runs on all pages, uses `DetectionManager` to find videos via DOM observation and network request interception, and injects download buttons. Proxies fetch requests through the service worker to bypass CORS.

3. **Offscreen Document** (`src/offscreen/` → `dist/offscreen/`): A hidden page created on demand for FFmpeg.wasm processing. Reads raw MPEG-TS chunks from IndexedDB, concatenates them, runs FFmpeg to mux into MP4, and returns a blob URL. Communicates with the service worker via messages since it can't use the Chrome downloads API directly.

4. **Popup** (`src/popup/` → `dist/popup/`): The extension action UI for manual URL input and download progress display.

5. **Options Page** (`src/options/` → `dist/options/`): Google Drive configuration (auth, folder settings, FFmpeg timeout).

### Download Flow

For HLS/M3U8 downloads:
1. Service worker creates a `DownloadManager`, which delegates to `HlsDownloadHandler` or `M3u8DownloadHandler`
2. Handler parses the playlist, downloads segments concurrently (up to `maxConcurrent`, default 3), stores raw chunks in IndexedDB (`core/database/chunks.ts`)
3. Handler sends `OFFSCREEN_PROCESS_HLS` message to offscreen document
4. Offscreen document concatenates chunks from IndexedDB, runs FFmpeg, returns blob URL
5. Service worker triggers Chrome download from the blob URL and saves the MP4

For direct downloads: the service worker uses `chrome.downloads.download()` directly.

### State Persistence

Download state is persisted in **IndexedDB** (not `chrome.storage`), in the `media-bridge` database (version 3) with two object stores:
- `downloads`: Full `DownloadState` objects keyed by `id`
- `chunks`: Raw `Uint8Array` segments keyed by `[downloadId, index]`

Configuration (Google Drive settings, FFmpeg timeout, max concurrent) lives in `chrome.storage.local` via `ChromeStorage` (`core/storage/chrome-storage.ts`).

### Message Protocol

All inter-component communication uses the `MessageType` enum in `src/shared/messages.ts`. When adding new message types, add them to this enum and handle them in the service worker's `onMessage` listener switch statement.

### Build System

The Vite config (`vite.config.ts`) has two important quirks:
- **Content script** is built in a separate Vite sub-build (IIFE format, `inlineDynamicImports: true`) triggered by the `build-content-script-as-iife` plugin. This avoids ES module restrictions for content scripts.
- **HTML files** are post-processed by the `move-html-files` plugin to fix script src paths from absolute to relative after Vite moves them.

FFmpeg WASM files are served from `public/ffmpeg/` and copied to `dist/ffmpeg/` at build time. They are explicitly excluded from Vite's dependency optimization.

### Path Alias

`@` resolves to `src/`. Use `@/core/types` instead of relative paths when importing from deep nesting.

### Format Detection

`VideoFormat` is `"direct" | "hls" | "m3u8" | "unknown"`. The distinction between `hls` (master playlist with quality variants) and `m3u8` (direct media playlist with segments) is significant — they use different handlers and FFmpeg processing paths.
