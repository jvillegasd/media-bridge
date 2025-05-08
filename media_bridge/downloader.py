from pathlib import Path
from typing import List, Optional

import yt_dlp

from media_bridge.integrations.base import CloudStorageUploader
from media_bridge.schemas import DownloaderParams


class Downloader:
    def __init__(self, params: DownloaderParams, uploaders: List[CloudStorageUploader]):
        self.params = params
        self.uploaders = uploaders
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

    def download_videos(self):
        urls = self.params.get_urls()
        output_path = self.params.output_path or Path.cwd()

        for i, url in enumerate(urls):
            custom_filename_for_this_url = None
            if len(urls) == 1 and self.params.filename:  # Filename only for single URL
                custom_filename_for_this_url = self.params.filename

            print(f"\nDownloading video from: {url}")
            downloaded_file_path = self._run_yt_dlp(
                url, output_path, filename=custom_filename_for_this_url
            )

            if downloaded_file_path and downloaded_file_path.exists():
                print(f"Successfully downloaded: {downloaded_file_path.name}")

                # If uploaders are configured, upload the file
                if self.uploaders:
                    print(f"Found {len(self.uploaders)} uploader(s) configured.")
                    for uploader_instance in self.uploaders:
                        uploader_name = uploader_instance.__class__.__name__
                        print(f"Attempting upload with {uploader_name}...")
                        try:
                            # Determine desired filename for upload, could be from params or original
                            # The uploader itself will handle its own rename_pattern or specific logic
                            upload_filename = (
                                custom_filename_for_this_url
                                or downloaded_file_path.stem
                            )

                            # Determine target location hint, specific to each uploader type
                            target_hint = None
                            if hasattr(
                                uploader_instance, "config"
                            ):  # Check if uploader has a config attribute
                                if hasattr(
                                    uploader_instance.config, "target_folder_id"
                                ):
                                    target_hint = (
                                        uploader_instance.config.target_folder_id
                                    )
                                elif hasattr(
                                    uploader_instance.config, "target_album_id"
                                ):
                                    target_hint = (
                                        uploader_instance.config.target_album_id
                                    )

                            uploaded_id = uploader_instance.upload_video(
                                local_path=downloaded_file_path,
                                desired_filename=upload_filename,
                                target_location_hint=target_hint,
                            )
                            if uploaded_id:
                                print(
                                    f"Successfully uploaded to {uploader_name}. ID: {uploaded_id}"
                                )
                            else:
                                print(
                                    f"Upload failed or no ID returned by {uploader_name}."
                                )
                        except Exception as e:
                            print(f"Error during upload with {uploader_name}: {e}")
                else:
                    print("No uploaders configured, skipping cloud upload.")
            else:
                print(f"Download failed for URL: {url}")

    def _run_yt_dlp(
        self, url: str, output_path: Path, filename: Optional[str] = None
    ) -> Optional[Path]:
        options = self._downloader_options.copy()
        options["outtmpl"] = str(output_path / (filename or "%(title)s.%(ext)s"))

        with yt_dlp.YoutubeDL(options) as ydl:
            ydl.download([url])

        return output_path / (filename or "%(title)s.%(ext)s")

    def _log_hook(self, download: dict):
        if download["status"] == "finished":
            self._downloaded_files.append(download["filename"])
