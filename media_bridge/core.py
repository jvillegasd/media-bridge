import argparse
import logging
from pathlib import Path
from typing import List, Optional

from pydantic import ValidationError
from rich.logging import RichHandler

from media_bridge.config import load_config
from media_bridge.downloader import Downloader
from media_bridge.integrations.base import CloudStorageUploader
from media_bridge.integrations.factory import create_uploaders
from media_bridge.schemas import Config, DownloaderParams
from media_bridge.state_manager import StateManager

# Setup a module-level logger. This will be the parent for loggers in other app modules.
logger = logging.getLogger("media_bridge")


def setup_logging(level=logging.INFO):
    """Configures logging for the application using RichHandler."""
    logging.basicConfig(
        level=level,
        format="%(message)s",  # RichHandler often overrides this.
        datefmt="[%X]",  # RichHandler often overrides this.
        handlers=[
            RichHandler(
                rich_tracebacks=True, show_path=False, show_level=True, show_time=True
            )
        ],
    )
    # Explicitly set the level for the application's root logger.
    # This helps ensure that even if basicConfig is called by a library,
    # our application's logger level is respected.
    logging.getLogger("media_bridge").setLevel(level)
    # You might also want to silence overly verbose library loggers here, e.g.:
    # logging.getLogger("googleapiclient.discovery_cache").setLevel(logging.ERROR)


def parse_pydantic_errors(e: ValidationError) -> List[str]:
    new_errors = [error["msg"] for error in e.errors()]
    return new_errors


def main():
    # Argument parsing must happen before logging setup if log level is a CLI arg
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
    parser.add_argument(
        "--log-level",
        type=str,
        default="INFO",
        choices=["DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"],
        help="Set the logging level (default: INFO)",
        # Convert to upper for case-insensitivity before passing to logging module
        # action="store", # default
        # dest="log_level_str" # if we want a different var name
    )

    args = parser.parse_args()

    # Setup logging AFTER parsing args so we can use args.log_level
    # Convert string level to logging level int
    numeric_log_level = getattr(logging, args.log_level.upper(), logging.INFO)
    setup_logging(level=numeric_log_level)

    # Now the logger is configured, we can use it for subsequent messages.
    logger.info(f"Log level set to: {args.log_level.upper()}")

    default_db_name = ".media_bridge_state.db"
    config_defined_db_path: Optional[Path] = None
    app_config: Optional[Config] = None
    params_dict = vars(args)
    uploaders: List[CloudStorageUploader] = []

    if args.config:
        logger.debug(f"Loading configuration from: {args.config}")
        raw_config_data = load_config(args.config)
        try:
            app_config = Config(**raw_config_data)
        except ValidationError as e:
            logger.error(
                f"Configuration validation error in {args.config}: {parse_pydantic_errors(e)}",
                exc_info=True,
            )
            return  # Exit if config is invalid

        if app_config.database_path:
            config_defined_db_path = app_config.database_path
        else:
            config_defined_db_path = args.config.parent / default_db_name
            logger.debug(
                f"No database_path in config, defaulting to: {config_defined_db_path}"
            )

        downloader_params_dict = {}
        if app_config:
            for k, v in app_config.model_dump(exclude_none=True).items():
                if k in DownloaderParams.__fields__:
                    downloader_params_dict[k] = v

        for key, value in downloader_params_dict.items():
            if key in params_dict and params_dict[key] is None:
                params_dict[key] = value
            elif key not in params_dict:
                params_dict[key] = value

        if app_config and app_config.storage:
            uploaders = create_uploaders(app_config.storage)
        else:
            logger.info(
                "No 'storage' section found in config or it is empty. No uploads will be performed."
            )
    else:
        logger.info(
            "No configuration file provided. Downloads will be local only. Using default DB path."
        )

    final_db_path = config_defined_db_path or Path.home() / default_db_name
    logger.info(f"Using state database at: {final_db_path}")

    state_manager = None
    try:
        state_manager = StateManager(db_path=final_db_path)
        params = DownloaderParams(**params_dict)  # Validate params after all merging
        downloader = Downloader(params, uploaders, state_manager)
        downloader.download_videos()

    except (
        ValidationError
    ) as e:  # Catches Pydantic validation errors for DownloaderParams
        logger.error(
            f"Parameter validation error: {parse_pydantic_errors(e)}", exc_info=True
        )
    except Exception as e:
        logger.error(
            f"An unexpected critical error occurred in main execution: {e}",
            exc_info=True,
        )
    finally:
        if state_manager:
            state_manager.close()


if __name__ == "__main__":
    main()
