import argparse
from pathlib import Path
from typing import List, Optional

from pydantic import ValidationError

from media_bridge.config import load_config
from media_bridge.downloader import Downloader
from media_bridge.integrations.base import CloudStorageUploader
from media_bridge.integrations.factory import create_uploaders
from media_bridge.schemas import DownloaderParams, StorageConfig


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
        parsed_storage_config: Optional[StorageConfig] = None
        uploaders: List[CloudStorageUploader] = []
        params_dict = vars(args)

        if args.config:
            config_data = load_config(args.config)

            # Extract downloader params from config
            downloader_params_dict = {}
            for k, v in config_data.items():
                if k in DownloaderParams.__fields__:
                    downloader_params_dict[k] = v

            # Override CLI args with config values if CLI args are None
            # This ensures CLI can still override specific config values if provided
            for key, value in downloader_params_dict.items():
                if key in params_dict and params_dict[key] is None:
                    params_dict[key] = value
                elif key not in params_dict:  # Add if not present from CLI
                    params_dict[key] = value

            # Get storage config and initialize uploaders
            if "storage" in config_data and config_data["storage"]:
                parsed_storage_config = StorageConfig(**config_data["storage"])
                uploaders = create_uploaders(parsed_storage_config)
            else:
                print("No 'storage' section found in config or it is empty.")

        else:  # No --config provided
            print("No configuration file provided. Downloads will be local only.")
            # Attempt to load default/environmental storage if desired in future, or ensure params are valid

        # Validate DownloaderParams after potential merge with config
        params = DownloaderParams(**params_dict)

        # Pass the list of uploaders to the Downloader
        downloader = Downloader(params, uploaders)  # Pass list of uploaders
        downloader.download_videos()
    except ValidationError as e:
        parser.error(parse_pydanctic_errors(e))


if __name__ == "__main__":
    main()
