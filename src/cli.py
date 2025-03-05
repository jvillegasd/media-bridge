import argparse
from downloader import Downloader
from schemas import DownloaderParams


def main():
    parser = argparse.ArgumentParser(description="Download videos using youtube-dl.")
    parser.add_argument("url", type=str, help="The URL of the video to download.")
    parser.add_argument(
        "--filename",
        type=str,
        help="Optional custom filename for the downloaded video (without extension)",
        default=None,
    )

    args = parser.parse_args()

    params = DownloaderParams(**vars(args))
    downloader = Downloader(params)

    downloader.download_video()


if __name__ == "__main__":
    main()
