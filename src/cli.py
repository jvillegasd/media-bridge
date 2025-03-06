import argparse

from pydantic import ValidationError

from src.downloader import Downloader
from src.schemas import DownloaderParams


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

    args = parser.parse_args()

    try:
        params = DownloaderParams(**vars(args))
        downloader = Downloader(params)
        downloader.download_videos()
    except ValidationError as e:
        parser.error(str(e))


if __name__ == "__main__":
    main()
