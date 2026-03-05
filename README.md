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
- **Download History**: Completed, failed, and cancelled downloads are persisted and browsable in the options page History section with infinite scroll
- **Notifications**: Optional OS notification and auto-open file on download completion
- **Cloud Upload**: Upload completed downloads to Google Drive or S3-compatible storage from the History page
- **Configurable Settings**: Recording poll intervals, fetch retry behaviour, detection cache sizes, IDB sync rate — all tunable from the options page

## ⚠️ Output File Size Limit

Because video processing uses **FFmpeg.wasm** (a WebAssembly build of FFmpeg running entirely inside the browser), output files are subject to browser memory limits. In practice, files above roughly **2 GB** will fail during the FFmpeg merge stage.

> **Planned**: A future release will replace FFmpeg.wasm with [mediabunny](https://github.com/nicktindall/mediabunny) for native-speed muxing without the 2 GB constraint.

## Cloud Upload Setup

Completed downloads can be uploaded to **Google Drive** or **S3-compatible storage** from **Options → History → item menu → Upload to cloud**.

### Google Drive

Google Drive requires you to create your own OAuth credentials (free):

1. Go to [Google Cloud Console](https://console.cloud.google.com/) and create a project (or use an existing one).
2. Enable the **[Google Drive API](https://console.cloud.google.com/apis/library/drive.googleapis.com)**.
3. Go to **[Credentials](https://console.cloud.google.com/apis/credentials)** → **Create Credentials** → **OAuth client ID**.
4. Set application type to **Web application**.
5. Under **Authorized redirect URIs**, add your extension's redirect URI.
   - Find it in **Options → Cloud Providers → Google Drive** — it's shown next to the Client ID field.
   - It looks like `https://<extension-id>.chromiumapp.org/`
6. Copy the **Client ID** and paste it into the options page.
7. Click **Sign in with Google** to authorize.

> **Note:** If you haven't configured a consent screen yet, Google will prompt you to create one. Choose **External** user type, fill in the required fields, and add yourself as a test user. The app will work in "Testing" mode — no verification needed for personal use.

### S3 / S3-Compatible Storage

1. In **Options → Cloud Providers → S3**, enter your bucket name, region, access key ID, and secret access key.
2. Your S3 bucket must have a CORS policy that allows the extension origin. The options page generates the correct JSON and provides a **Copy CORS Config** button — paste it into **S3 → Bucket → Permissions → CORS**.
3. Works with AWS S3, Cloudflare R2, Backblaze B2, Wasabi, MinIO, and any S3-compatible provider.

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
4. **Popup** (`src/popup/`): Extension action UI — Videos tab (detected videos), Downloads tab (in-progress only), Manifest tab (manual URL + quality selector). A History button opens the options page directly on the history section.
5. **Options Page** (`src/options/`): Full settings UI with sidebar navigation — Download, History, Google Drive, S3, Recording, Notifications, and Advanced sections. All settings changes are confirmed via a bottom toast notification.

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
| **IndexedDB** (`media-bridge` v3) | `downloads` (state + history), `chunks` (segments) | Survives restarts; supports large `ArrayBuffer` |
| **`chrome.storage.local`** | All config via `loadSettings()` / `AppSettings` | Simple K/V; 10 MB quota |

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
│   │   ├── chrome-storage.ts  # Raw chrome.storage.local access
│   │   └── settings.ts        # AppSettings interface + loadSettings() — always use this
│   ├── cloud/                 # Google Drive + S3 upload providers
│   │   ├── google-auth.ts     # OAuth via launchWebAuthFlow (user-provided client ID)
│   │   ├── google-drive.ts    # Resumable upload (chunked for files > 5 MB)
│   │   ├── s3-client.ts       # SigV4-signed PUT / multipart upload
│   │   └── upload-manager.ts  # Provider registry + routing
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
├── options/                   # Options page (Download, History, Drive, S3, Recording, Notifications, Advanced)
├── offscreen/                 # Offscreen document (FFmpeg.wasm processing)
└── types/
    └── mpd-parser.d.ts        # Type declarations for mpd-parser
```

### Permissions

- `storage` — Config persistence
- `downloads` — Save downloaded files
- `identity` — Google OAuth via `launchWebAuthFlow`
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
- Increase FFmpeg timeout in **Options → Download Settings** if processing is slow
- Check the offscreen document console for FFmpeg error output

### Extension Not Detecting Videos
- Some sites obfuscate network requests or use proprietary players
- Use the **Manifest** tab to paste the URL manually
- Check browser console for content script errors

## License

MIT License — see LICENSE file for details
