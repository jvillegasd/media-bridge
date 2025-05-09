import argparse
from pathlib import Path
from typing import List, Optional

from pydantic import ValidationError

from media_bridge.config import load_config
from media_bridge.downloader import Downloader
from media_bridge.integrations.base import CloudStorageUploader
from media_bridge.integrations.factory import create_uploaders
from media_bridge.schemas import Config, DownloaderParams, StorageConfig
from media_bridge.state_manager import StateManager


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

    # Determine database path
    # Default to a file in the user's home directory if not specified
    # This ensures a consistent db location if no config is used or if db_path is omitted
    default_db_name = ".media_bridge_state.db"
    config_defined_db_path: Optional[Path] = None
    app_config: Optional[Config] = None

    params_dict = vars(args)

    if args.config:
        raw_config_data = load_config(args.config)
        app_config = Config(
            **raw_config_data
        )  # Parse the full config including db_path

        if app_config.database_path:
            config_defined_db_path = app_config.database_path
        else:
            # If config file is provided but no db_path, store db next to config file
            config_defined_db_path = args.config.parent / default_db_name

        # Extract downloader params from config
        downloader_params_dict = {}
        if app_config:
            for k, v in app_config.model_dump(
                exclude_none=True
            ).items():  # Use model_dump
                if k in DownloaderParams.__fields__:
                    downloader_params_dict[k] = v

        for key, value in downloader_params_dict.items():
            if key in params_dict and params_dict[key] is None:
                params_dict[key] = value
            elif key not in params_dict:
                params_dict[key] = value

        parsed_storage_config: Optional[StorageConfig] = None
        uploaders: List[CloudStorageUploader] = []
        if app_config and app_config.storage:
            parsed_storage_config = app_config.storage  # Already parsed StorageConfig
            uploaders = create_uploaders(parsed_storage_config)
        else:
            print("No 'storage' section found in config or it is empty.")

    final_db_path = config_defined_db_path or Path.home() / default_db_name

    try:
        state_manager = StateManager(db_path=final_db_path)

        # Validate DownloaderParams after potential merge with config
        params = DownloaderParams(**params_dict)

        # Pass the list of uploaders and state_manager to the Downloader
        downloader = Downloader(params, uploaders, state_manager)
        downloader.download_videos()

    except ValidationError as e:
        parser.error(str(parse_pydanctic_errors(e)))  # Ensure error is string
    except Exception as e:
        # General exception handling for other potential errors during setup or run
        print(f"An unexpected error occurred: {e}")
        # Consider if state_manager needs to be closed here if it was initialized
    finally:
        # Ensure StateManager is closed if it was initialized, regardless of success/failure
        # This requires state_manager to be defined outside the try block or checked carefully
        if "state_manager" in locals() and state_manager:  # Check if initialized
            state_manager.close()
            print("StateManager closed.")


if __name__ == "__main__":
    main()
