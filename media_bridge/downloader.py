from pathlib import Path
from typing import Optional

import yt_dlp

from media_bridge.integrations import GoogleDriveUploader, GooglePhotosUploader
from media_bridge.schemas import DownloaderParams, StorageConfig


class Downloader:
    def __init__(
        self, params: DownloaderParams, storage_config: Optional[StorageConfig] = None
    ):
        self.params = params
        self.storage_config = storage_config
        self._downloaded_files = []
        output_template = "%(title)s.%(ext)s"

        if self.params.filename:
            output_template = f"{self.params.filename}.%(ext)s"

        if self.params.output_path:
            output_template = str(self.params.output_path / output_template)

        self._downloader_options = {
            "format": "best",
            "outtmpl": output_template,
            "sleep_interval": 1,
            "max_sleep_interval": 5,
            "progress_hooks": [self._log_hook],
        }

    def download_videos(self) -> list[str]:
        """
        Download videos and optionally upload them to configured cloud storage services

        Returns:
            List of paths to downloaded files
        """
        self._downloaded_files = []

        options = self._downloader_options.copy()

        with yt_dlp.YoutubeDL(options) as ydl:
            ydl.download(self.params.get_urls())

        # Upload to cloud storage if configured
        self._upload_to_cloud_storage()

        return self._downloaded_files

    def _log_hook(self, download: dict):
        if download["status"] == "finished":
            self._downloaded_files.append(download["filename"])

    def _upload_to_cloud_storage(self):
        """Upload downloaded files to configured cloud storage services"""
        if not self.storage_config:
            return

        for file_path in self._downloaded_files:
            path = Path(file_path)

            # Extract base filename without extension for use in renaming
            base_name = path.stem

            # Upload to Google Drive if enabled
            if (
                self.storage_config.google_drive
                and self.storage_config.google_drive.enabled
            ):
                try:
                    drive_uploader = GoogleDriveUploader(
                        self.storage_config.google_drive
                    )
                    drive_file_id = drive_uploader.upload_video(
                        path,
                        desired_filename=base_name if self.params.filename else None,
                        target_location_hint=None,  # Use the one from config
                    )
                    print(f"Uploaded to Google Drive: {drive_file_id}")
                except Exception as e:
                    print(f"Error uploading to Google Drive: {e}")

            # Upload to Google Photos if enabled
            if (
                self.storage_config.google_photos
                and self.storage_config.google_photos.enabled
            ):
                try:
                    photos_uploader = GooglePhotosUploader(
                        self.storage_config.google_photos
                    )
                    media_item_id = photos_uploader.upload_video(
                        path,
                        desired_filename=base_name if self.params.filename else None,
                        target_location_hint=None,  # Use the one from config
                    )
                    print(f"Uploaded to Google Photos: {media_item_id}")
                except Exception as e:
                    print(f"Error uploading to Google Photos: {e}")
