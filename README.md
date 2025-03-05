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

To download a video:

```bash
poetry run python src/cli.py "VIDEO_URL"
```

Example:
```bash
poetry run python src/cli.py "https://www.youtube.com/watch?v=example"
```

## Project Structure

```
media-bridge/
├── src/
│   ├── cli.py         # Command-line interface
│   └── downloader.py  # Download functionality
├── pyproject.toml     # Poetry configuration
└── README.md         
```

## License

This project is licensed under the MIT License.
