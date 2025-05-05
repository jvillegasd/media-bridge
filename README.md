# Media Bridge

A Python-based CLI tool that acts as a bridge, downloading media content using yt-dlp and seamlessly uploading it to configured cloud storage services like Google Drive and Google Photos.

## Features

- Download videos from YouTube and other supported platforms
- Simple command-line interface
- Built with yt-dlp for reliable downloads
- Python 3.12+ compatible
- Cloud storage integration:
  - Upload downloaded media to Google Photos
  - Upload downloaded media to Google Drive

## Future Features

- Support for additional cloud storage platforms
- Direct upload to locked folder in Google Photos (when API supports it)

## Prerequisites

- Python 3.12 or higher
- Poetry (for dependency management)
- FFmpeg and FFprobe (Required for media processing)
  - Strongly recommended to use [yt-dlp's custom FFmpeg builds](https://github.com/yt-dlp/FFmpeg-Builds#ffmpeg-builds) to avoid known issues
  - Note: You need the FFmpeg binary, not the Python package
- Google API Credentials (for cloud storage uploads)

## Installation

1. Clone the repository:
```bash
git clone https://github.com/yourusername/media-bridge.git
cd media-bridge
```

2. Install dependencies using Poetry:
```bash
poetry install
```

## Usage

The CLI supports both single and multiple URL downloads with validation, as well as YAML configuration files:

```bash
# Single URL download
poetry run media-bridge --url "VIDEO_URL"

# Multiple URLs download
poetry run media-bridge --urls "VIDEO_URL1" "VIDEO_URL2" "VIDEO_URL3"

# Using a configuration file
poetry run media-bridge --config "path/to/config.yml"
```

### Command Line Options

- `--url`: Single video URL to download
- `--urls`: Multiple video URLs to download
- `--filename`: Custom filename (without extension, only for single URL)
- `--output-path`: Custom output directory path
- `--config`: Path to YAML configuration file

### Configuration File

You can use a YAML configuration file to specify download options and cloud storage integrations:

```yaml
output_path: "~/Desktop"  # Output directory for downloads
urls:                     # List of URLs to download
  - "https://www.youtube.com/watch?v=video1"
  - "https://www.youtube.com/watch?v=video2"
filename: "custom-name"   # Optional: Custom filename (only for single URL)

# Cloud Storage Configuration
storage:
  # Google Drive Configuration
  google_drive:
    enabled: true
    credentials_file: /path/to/google_drive_credentials.json
    target_folder_id: "your_folder_id_here"  # Optional
    create_folder_if_not_exists: true
    rename_pattern: "My Video"  # Optional
    token_file: "/path/to/your/google_drive_token.json" # Optional: Where to store the token, defaults to beside credentials_file

  # Google Photos Configuration
  google_photos:
    enabled: true
    credentials_file: /path/to/google_photos_credentials.json
    target_album_id: "your_album_id_here"  # Optional
    create_album_if_not_exists: true
    rename_as_description: true
    archive_after_upload: false # Note: Archiving currently not supported via API
    token_file: "/path/to/your/google_photos_token.json" # Optional: Where to store the token, defaults to beside credentials_file
```

A complete sample configuration file is available at `config_example.yaml`.

### Cloud Storage Integration

#### Google Drive

Upload downloaded videos to Google Drive with the following options:

- **enabled**: Set to `true` to enable Google Drive uploads
- **credentials_file**: Path to your Google Drive API credentials JSON file
- **target_folder_id**: (Optional) Specific folder ID to upload to
- **create_folder_if_not_exists**: If true and no target folder is specified, creates a "MediaBridge Uploads" folder
- **rename_pattern**: (Optional) Custom filename pattern for uploaded files

#### Google Photos

Upload downloaded videos to Google Photos with the following options:

- **enabled**: Set to `true` to enable Google Photos uploads
- **credentials_file**: Path to your Google Photos API credentials JSON file
- **target_album_id**: (Optional) Specific album ID to upload to
- **create_album_if_not_exists**: If true and no target album is specified, creates a "MediaBridge Uploads" album
- **rename_as_description**: If true, uses the local filename as the description (Google Photos API doesn't support direct file renaming)
- **archive_after_upload**: If true, uploaded media will be archived (hidden from the main library)

### Google API Credentials

To use the cloud storage features, you'll need to set up Google API credentials:

1. Go to the [Google Cloud Console](https://console.cloud.google.com/)
2. Create a new project or select an existing one.
3. Enable the **Google Drive API** and/or **Google Photos Library API**.
4. Create OAuth 2.0 Client ID credentials:
   - Go to "Credentials" in the APIs & Services section.
   - Click "+ CREATE CREDENTIALS" and select "OAuth client ID".
   - Choose "Desktop app" as the Application type.
   - Give it a name (e.g., "MediaBridge Desktop Client").
   - Click "Create".
   - Download the JSON file. This file contains your client ID and client secret.
   - **Important:** Save this JSON file (often named `client_secrets.json` or similar) in a secure location.
   - Reference the path to this downloaded JSON file in the `credentials_file` field in your `config.yaml`.
5. **First Run Authorization:** The first time you run `media-bridge` with a cloud storage integration enabled, it will automatically open a web browser window asking you to log in to your Google account and grant permission for the application to access the requested services (Drive and/or Photos).
6. **Token Storage:** After you grant permission, the application will save an authorization token (containing access and refresh tokens) to a file (e.g., `drive_token.json` or `photos_token.json`). By default, this token file is saved in the same directory as your `credentials_file`. You can specify a different location using the optional `token_file` setting in your `config.yaml`.
7. **Security:** Ensure the downloaded credentials JSON file and the generated token file are kept secure and are **not** committed to version control (add `*token.json` to your `.gitignore`).

For more detailed background, see the [Google API Setup Guide](https://developers.google.com/workspace/guides/create-credentials).

### Validation Features

- At least one URL must be provided (either --url or --urls)
- Custom filename (--filename) can only be used with single URL downloads
- Mutually exclusive URL options (cannot use --url and --urls together)

Examples:

```bash
# Download a single video
poetry run media-bridge --url "https://www.youtube.com/watch?v=dQw4w9WgXcQ"

# Download multiple videos
poetry run media-bridge --urls "https://www.youtube.com/watch?v=video1" "https://www.youtube.com/watch?v=video2"

# Download with custom filename
poetry run media-bridge --url "https://www.youtube.com/watch?v=dQw4w9WgXcQ" --filename "rick-roll"

# Download with custom output path
poetry run media-bridge --url "https://www.youtube.com/watch?v=dQw4w9WgXcQ" --output-path "./downloads"

# Download and upload to cloud storage using config
poetry run media-bridge --url "https://www.youtube.com/watch?v=dQw4w9WgXcQ" --config "my_config.yaml"
```

The downloaded files will be saved in the current directory unless --output-path is specified.

## Project Structure

```
media-bridge/
├── media_bridge/
│   ├── core.py             # Command-line interface
│   ├── downloader.py       # Download functionality
│   ├── schemas.py          # Data validation schemas
│   ├── config.py           # Configuration loading
│   └── integrations/       # Cloud storage integrations
│       ├── base.py         # Base storage uploader class
│       ├── google_drive.py # Google Drive integration
│       └── google_photos.py # Google Photos integration
├── tests/                  # Test files
├── pyproject.toml          # Poetry configuration
└── README.md
```

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.
