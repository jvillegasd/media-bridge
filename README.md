# Media Bridge

A Python-based CLI tool that downloads media content from various platforms using yt-dlp. This tool is designed to be simple, efficient, and easy to use.

## Features

- Download videos from YouTube and other supported platforms
- Simple command-line interface
- Built with yt-dlp for reliable downloads
- Python 3.12+ compatible

## Future Features

- Cloud upload integration:
  - Upload downloaded media to Google Photos
  - Upload downloaded media to Google Drive
  - Support for additional cloud storage platforms planned

## Prerequisites

- Python 3.12 or higher
- Poetry (for dependency management)
- FFmpeg and FFprobe (Required for media processing)
  - Strongly recommended to use [yt-dlp's custom FFmpeg builds](https://github.com/yt-dlp/FFmpeg-Builds#ffmpeg-builds) to avoid known issues
  - Note: You need the FFmpeg binary, not the Python package

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

You can use a YAML configuration file to specify download options:

```yaml
output_path: "~/Desktop"  # Output directory for downloads
urls:                     # List of URLs to download
  - "https://www.youtube.com/watch?v=video1"
  - "https://www.youtube.com/watch?v=video2"
filename: "custom-name"   # Optional: Custom filename (only for single URL)
```

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
```

The downloaded files will be saved in the current directory unless --output-path is specified.

## Project Structure

```
media-bridge/
├── media_bridge/
│   ├── core.py       # Command-line interface
│   ├── downloader.py # Download functionality
│   └── schemas.py    # Data validation schemas
├── tests/            # Test files
├── pyproject.toml    # Poetry configuration
└── README.md
```

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.
