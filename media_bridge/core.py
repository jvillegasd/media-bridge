import argparse
from pathlib import Path
from typing import List

from pydantic import ValidationError

from media_bridge.config import load_config
from media_bridge.downloader import Downloader
from media_bridge.schemas import DownloaderParams


def parse_pydanctic_errors(e: ValidationError) -> List[str]:
    new_errors = [error["msg"] for error in e.errors()]
    return new_errors


def main():
    parser = argparse.ArgumentParser(description="Download videos using youtube-dl.")
    url_group = parser.add_mutually_exclusive_group()
    url_group.add_argument(
        "--url", type=str, help="Single URL of the video to download."
    )
    url_group.add_argument("--urls", nargs="+", help="Multiple URLs to download.")
    parser.add_argument(
        "--filename",
        type=str,
        help="Optional custom filename for the downloaded video (without extension, only works with single URL)",
        default=None,
    )
    parser.add_argument(
        "--output-path",
        type=Path,
        help="Optional output directory for downloaded files",
        default=None,
    )
    parser.add_argument(
        "--config",
        type=Path,
        help="Path to YAML configuration file",
        default=None,
    )

    args = parser.parse_args()

    try:
        params_dict = vars(args)
        if args.config:
            config_data = load_config(args.config)
            # Remove None values from CLI args to allow config values to take precedence
            params_dict.update(
                {
                    k: v
                    for k, v in config_data.items()
                    if k in DownloaderParams.__annotations__
                }
            )

        params = DownloaderParams(**params_dict)
        downloader = Downloader(params)
        downloader.download_videos()
    except ValidationError as e:
        parser.error(parse_pydanctic_errors(e))


if __name__ == "__main__":
    main()
