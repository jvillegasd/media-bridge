# Media Bridge Browser Extension

A Chromium browser extension that downloads videos from the web (HLS, DASH, and direct video URLs) and optionally uploads them to Google Drive.

## Features

- **Multiple Format Support**: Download HLS (.m3u8), DASH/MPD, and direct video URLs
- **Automatic Video Detection**: Content script automatically detects videos on web pages
- **Popup Interface**: Easy-to-use popup for manual URL downloads
- **Google Drive Integration**: Automatically upload downloaded videos to Google Drive
- **Progress Tracking**: Real-time download and upload progress
- **Segment Merging**: Uses FFmpeg.wasm to merge HLS/DASH segments into MP4 files
- **Concurrent Downloads**: Download multiple segments simultaneously for faster downloads

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
2. Paste a video URL (HLS, DASH, or direct video)
3. Click "Download"

### Automatic Detection

When visiting a page with video content:
- The extension automatically detects videos
- A download button appears next to detected videos
- Click the button to start downloading

### Google Drive Integration

1. Open extension options (right-click extension icon → Options)
2. Enable "Enable Google Drive uploads"
3. Click "Sign in with Google" to authenticate
4. Configure folder settings (optional)
5. Save settings

Videos will now automatically upload to Google Drive after downloading.

## Configuration

### Google Drive Settings

- **Folder Name**: Name of the folder to store uploads (created automatically if it doesn't exist)
- **Target Folder ID**: Specific Google Drive folder ID to upload to (optional)
- **Max Concurrent Downloads**: Number of segments to download simultaneously (1-10)

## Supported Formats

- **HLS (HTTP Live Streaming)**: `.m3u8` playlists, master and media playlists
- **DASH (Dynamic Adaptive Streaming)**: `.mpd` manifests, video and audio streams
- **Direct Video URLs**: MP4, WebM, and other direct video formats

## Technical Details

### Architecture

- **Background Service Worker**: Handles download orchestration and state management
- **Content Script**: Detects videos on web pages and injects download buttons
- **Popup UI**: User interface for manual downloads and viewing progress
- **Options Page**: Configuration interface for Google Drive settings

### Technologies

- TypeScript for type safety
- Webpack for bundling
- FFmpeg.wasm for segment merging
- Chrome Extension APIs (storage, downloads, identity)
- Google Drive API v3

### Permissions

- `storage`: Store download state and configuration
- `downloads`: Save downloaded files
- `identity`: Google OAuth authentication
- `activeTab`: Access current tab for video detection
- `scripting`: Inject content scripts
- Host permissions: Access video URLs from various domains

## Development

### Build Commands

```bash
# Development build with watch mode
npm run dev

# Production build
npm run build

# Type checking
npm run type-check
```

### Project Structure

```
src/
├── background/          # Service worker
├── content/            # Content script
├── popup/              # Popup UI
├── options/            # Options page
├── lib/
│   ├── downloader/     # Download logic
│   ├── parsers/       # HLS/MPD parsers
│   ├── merger/        # Segment merging
│   ├── storage/       # Storage utilities
│   └── cloud/         # Google Drive integration
└── shared/            # Shared types and messages
```

## Limitations

- DRM-protected content cannot be downloaded
- Some websites may block video downloading
- Large files may take significant time to process
- FFmpeg.wasm has size limitations (consider native messaging for very large files)

## Troubleshooting

### Download Fails

- Check if the URL is accessible and not DRM-protected
- Verify network connection
- Check browser console for error messages

### Google Drive Upload Fails

- Ensure you're signed in (check Options page)
- Verify Google Drive API is enabled
- Check that you have sufficient storage quota

### Extension Not Detecting Videos

- Some websites use complex player implementations
- Try using the manual download feature with the video URL
- Check browser console for errors

## License

MIT License - see LICENSE file for details
