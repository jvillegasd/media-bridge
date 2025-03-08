# Media Bridge

A Python-based CLI tool that downloads media content from various platforms using yt-dlp. This tool is designed to be simple, efficient, and easy to use.

## Features

- Download videos from YouTube and other supported platforms
- Simple command-line interface
- Built with yt-dlp for reliable downloads
- Python 3.12+ compatible

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

The CLI supports both single and multiple URL downloads with validation:

```bash
# Single URL download
poetry run python src/cli.py --url "VIDEO_URL"

# Multiple URLs download
poetry run python src/cli.py --urls "VIDEO_URL1" "VIDEO_URL2" "VIDEO_URL3"

# Single URL with custom filename
poetry run python src/cli.py --url "VIDEO_URL" --filename "my-video"
```

### Validation Features

- At least one URL must be provided (either --url or --urls)
- Custom filename (--filename) can only be used with single URL downloads
- Mutually exclusive URL options (cannot use --url and --urls together)

Examples:

```bash
# Download a single video
poetry run python src/cli.py --url "https://www.youtube.com/watch?v=dQw4w9WgXcQ"

# Download multiple videos
poetry run python src/cli.py --urls "https://www.youtube.com/watch?v=video1" "https://www.youtube.com/watch?v=video2"

# Download with custom filename
poetry run python src/cli.py --url "https://www.youtube.com/watch?v=dQw4w9WgXcQ" --filename "rick-roll"

# Download with custom output path
poetry run python src/cli.py --url "https://www.youtube.com/watch?v=dQw4w9WgXcQ" --output "path/to/save"
```

The downloaded files will be saved in the current directory.

## Project Structure

```
media-bridge/
├── src/
│   ├── cli.py         # Command-line interface
│   ├── downloader.py  # Download functionality
│   └── schemas.py     # Data validation schemas
├── pyproject.toml     # Poetry configuration
└── README.md
```

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.
