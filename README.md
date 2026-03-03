# Media Bridge Browser Extension

A Manifest V3 Chromium extension that detects and downloads videos from the web — HLS, MPEG-DASH, and direct video URLs.

## Features

- **Multiple Format Support**: HLS (`.m3u8`), MPEG-DASH (`.mpd`), and direct video URLs (`.mp4`, `.webm`, etc.)
- **Automatic Video Detection**: Content script detects videos via DOM observation and network request interception
- **Live Stream Recording**: Record live HLS and DASH streams in real-time with a REC button
- **Popup Interface**: Manual URL input with quality selector for HLS/DASH playlists
- **Real-time Progress**: Download speed, percentage, and stage displayed live
- **Segment Merging**: FFmpeg.wasm muxes HLS/DASH segments into MP4 files
- **Concurrent Downloads**: Up to 10 simultaneous segment downloads (default: 3)
- **Partial Save on Cancel**: Save whatever segments were collected before cancellation
- **AES-128 Decryption**: Decrypts encrypted HLS segments transparently
- **Header Injection**: Injects `Origin`/`Referer` headers via `declarativeNetRequest` for CDNs that require them

## ⚠️ Output File Size Limit

Because video processing uses **FFmpeg.wasm** (a WebAssembly build of FFmpeg running entirely inside the browser), output files are subject to browser memory limits. In practice, files above roughly **2 GB** will fail during the FFmpeg merge stage.

> **Planned**: A future release will replace FFmpeg.wasm with [mediabunny](https://github.com/nicktindall/mediabunny) for native-speed muxing without the 2 GB constraint.

## Planned Features

The following features are planned but not yet implemented:

- **Cloud storage uploads**: The code infrastructure for Google Drive exists (`core/cloud/`) but is not wired up — no uploads are triggered after downloads complete. Future versions will support Google Drive and other cloud providers (S3, Dropbox, etc.).

## Installation

### Development Build

1. Clone the repository:
```bash
git clone <repository-url>
cd media-bridge
```

2. Install dependencies:
```bash
npm install
```

3. Build the extension:
```bash
npm run build
```

4. Load the extension in Chrome:
   - Open Chrome and navigate to `chrome://extensions/`
   - Enable "Developer mode" (toggle in top right)
   - Click "Load unpacked"
   - Select the `dist` directory

### Production Build

```bash
npm run build
```

The built extension will be in the `dist` directory.

## Usage

### Manual Download

1. Click the extension icon in your browser toolbar
2. Go to the **Manifest** tab
3. Paste a video URL (HLS, DASH, or direct video)
4. Select quality (for HLS/DASH playlists)
5. Click "Download"

### Automatic Detection

When visiting a page with video content:
- The extension automatically detects videos via network request interception
- Detected videos appear in the **Videos** tab
- Click "Download" to start

### Live Stream Recording

When a live stream is detected:
- A **REC** button appears in the popup
- Click REC to start recording segments in real-time
- Click STOP to stop — segments collected so far are merged into an MP4

## Supported Formats

| Format | Detection | VOD Download | Live Recording |
|--------|-----------|-------------|----------------|
| **HLS** (`.m3u8` master playlist) | ✅ | ✅ | ✅ |
| **M3U8** (`.m3u8` media playlist) | ✅ | ✅ | — |
| **DASH** (`.mpd` manifest) | ✅ | ✅ | ✅ |
| **Direct** (`.mp4`, `.webm`, etc.) | ✅ | ✅ | — |

## Technical Details

### Architecture

Media Bridge has five distinct execution contexts that communicate via `chrome.runtime.sendMessage`:

1. **Service Worker** (`src/service-worker.ts`): Central orchestrator. Routes messages, manages download lifecycle, keeps itself alive via heartbeat.
2. **Content Script** (`src/content.ts`): Runs on all pages. Detects videos via DOM observation and network interception. Proxies fetch requests through the service worker to bypass CORS.
3. **Offscreen Document** (`src/offscreen/`): Hidden page that runs FFmpeg.wasm. Reads segment data from IndexedDB, muxes into MP4, returns a blob URL.
4. **Popup** (`src/popup/`): Extension action UI — Videos tab, Downloads tab, Manifest tab.
5. **Options Page** (`src/options/`): Configuration (FFmpeg timeout, max concurrent).

### Download Flow

**HLS / DASH VOD**:
1. Service worker creates a `DownloadManager`, which delegates to the format-specific handler
2. Handler parses the manifest and selects highest-bandwidth video + audio
3. Segments downloaded concurrently (up to `maxConcurrent`), stored as `Uint8Array` in IndexedDB
4. `OFFSCREEN_PROCESS_*` message triggers FFmpeg muxing in the offscreen document
5. FFmpeg returns a blob URL; service worker triggers `chrome.downloads.download()` → saves MP4

**Direct URLs**: `chrome.downloads.download()` used directly, no FFmpeg needed.

**Live Recording**: Handler polls the media playlist/MPD at the stream's native interval, collecting new segments. On stop (or stream end), collected chunks are merged into an MP4.

### State Persistence

| Store | Data | Reason |
|-------|------|--------|
| **IndexedDB** (`media-bridge` v3) | `downloads` (state), `chunks` (segments) | Survives restarts; supports large `ArrayBuffer` |
| **`chrome.storage.local`** | Config (FFmpeg timeout, concurrency) | Simple K/V; 10 MB quota |

### Project Structure

```
src/
├── service-worker.ts          # Background service worker (central hub)
├── content.ts                 # Content script (IIFE format, video detection)
├── shared/
│   ├── messages.ts            # MessageType enum (all inter-context messages)
│   └── constants.ts           # Global defaults (concurrency, timeouts, etc.)
├── core/
│   ├── types/
│   │   └── index.ts           # VideoFormat, DownloadState, DownloadStage, Fragment, Level
│   ├── detection/
│   │   ├── detection-manager.ts
│   │   ├── thumbnail-utils.ts
│   │   ├── direct/            # Direct video detection
│   │   ├── hls/               # HLS detection
│   │   └── dash/              # DASH detection
│   ├── downloader/
│   │   ├── download-manager.ts
│   │   ├── base-playlist-handler.ts   # Shared segment download logic
│   │   ├── base-recording-handler.ts  # Shared live recording logic
│   │   ├── concurrent-workers.ts
│   │   ├── crypto-utils.ts    # AES-128 decryption
│   │   ├── header-rules.ts    # declarativeNetRequest header injection
│   │   ├── direct/            # Direct download handler
│   │   ├── hls/               # HLS download + recording handlers
│   │   ├── m3u8/              # M3U8 (media playlist) handler
│   │   └── dash/              # DASH download + recording handlers
│   ├── parsers/
│   │   ├── m3u8-parser.ts     # HLS playlist parsing (m3u8-parser)
│   │   ├── mpd-parser.ts      # DASH/MPD parsing (mpd-parser)
│   │   └── playlist-utils.ts  # Shared ParsedPlaylist/ParsedSegment types
│   ├── ffmpeg/
│   │   ├── ffmpeg-bridge.ts   # Unified FFmpeg request interface
│   │   ├── ffmpeg-singleton.ts
│   │   └── offscreen-manager.ts
│   ├── database/
│   │   ├── connection.ts      # IDB init (media-bridge v3)
│   │   ├── downloads.ts       # Download state CRUD
│   │   └── chunks.ts          # Segment chunk storage
│   ├── storage/
│   │   └── chrome-storage.ts  # Config via chrome.storage.local
│   ├── cloud/                 # ⚠️ Planned — infrastructure exists, not yet wired up
│   │   ├── google-auth.ts
│   │   ├── google-drive.ts
│   │   └── upload-manager.ts
│   ├── metadata/
│   │   └── metadata-extractor.ts
│   └── utils/
│       ├── blob-utils.ts
│       ├── cancellation.ts
│       ├── crypto-utils.ts    # AES-128 decryption
│       ├── download-utils.ts
│       ├── drm-utils.ts       # DRM detection (FairPlay, PlayReady)
│       ├── errors.ts          # Custom error classes
│       ├── fetch-utils.ts     # CORS-aware fetch with retries
│       ├── file-utils.ts
│       ├── format-utils.ts
│       ├── id-utils.ts
│       ├── logger.ts
│       └── url-utils.ts
├── popup/                     # Popup UI (Videos / Downloads / Manifest tabs)
├── options/                   # Options page (FFmpeg timeout, concurrency)
├── offscreen/                 # Offscreen document (FFmpeg.wasm processing)
└── types/
    └── mpd-parser.d.ts        # Type declarations for mpd-parser
```

### Permissions

- `storage` — Config persistence
- `downloads` — Save downloaded files
- `identity` — OAuth (reserved for future cloud upload)
- `activeTab` / `scripting` — Content script injection
- `offscreen` — Offscreen document for FFmpeg.wasm
- `unlimitedStorage` — Large segment storage in IndexedDB
- `webRequest` — Intercept `.m3u8` / `.mpd` network requests
- `declarativeNetRequest` — Inject `Origin`/`Referer` headers
- `tabs` / `webNavigation` — Tab tracking for video detection
- Host permissions (`http://*/* https://*/*`) — Fetch video content

## Development

### Build Commands

```bash
# Development build with watch mode
npm run dev

# Production build
npm run build

# TypeScript type checking only
npm run type-check
```

### Key Dependencies

| Package | Purpose |
|---------|---------|
| `@ffmpeg/ffmpeg` `@ffmpeg/util` | FFmpeg.wasm segment muxing (≤ ~2 GB output) |
| `m3u8-parser` | HLS playlist parsing |
| `mpd-parser` | DASH/MPD manifest parsing |
| `idb` | IndexedDB wrapper |
| `uuid` | Unique download IDs |
| `url-toolkit` | URL resolution for relative segment paths |
| `@reduxjs/toolkit` `redux-observable` `rxjs` | State management |

## Limitations

- **~2 GB output limit** — FFmpeg.wasm runs in browser memory; files larger than ~2 GB fail during merging. Planned fix: migrate to mediabunny.
- **DRM content** — FairPlay and PlayReady protected streams cannot be downloaded.
- **CDN restrictions** — Some sites block extension requests via token auth or IP restrictions.
- **Browser memory** — Total concurrent segment data is limited by available RAM.

## Troubleshooting

### Download Fails
- Verify the URL is accessible and not DRM-protected
- Check browser console for errors
- Ensure the format is supported (HLS, DASH, or direct)

### FFmpeg Merge Fails
- File may exceed the ~2 GB limit — try a shorter clip or lower quality
- Increase FFmpeg timeout in Options if processing is slow
- Check the offscreen document console for FFmpeg error output

### Extension Not Detecting Videos
- Some sites obfuscate network requests or use proprietary players
- Use the **Manifest** tab to paste the URL manually
- Check browser console for content script errors

## License

MIT License — see LICENSE file for details
