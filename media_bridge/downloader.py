import logging
from pathlib import Path
from typing import List, Optional

import yt_dlp
from rich.progress import (
    BarColumn,
    Progress,
    TextColumn,
    TimeElapsedColumn,
    TimeRemainingColumn,
)

from media_bridge.error_handler import (
    NetworkError,
    ResourceNotFoundError,
    ValidationError,
    with_retry,
)
from media_bridge.integrations.base import CloudStorageUploader
from media_bridge.schemas import DownloaderParams
from media_bridge.state_manager import StateManager
from media_bridge.status import MediaStatus, UploadStatus

logger = logging.getLogger("media_bridge.downloader")


class Downloader:
    def __init__(
        self,
        params: DownloaderParams,
        uploaders: List[CloudStorageUploader],
        state_manager: StateManager,
        output_dir: Path,
        max_retries: int = 3,
        retry_delay: float = 1.0,
    ):
        self.params = params
        self.uploaders = uploaders
        self.state_manager = state_manager
        self._downloaded_files_session_cache = {}
        self.output_dir = output_dir
        self.max_retries = max_retries
        self.retry_delay = retry_delay
        self.output_dir.mkdir(parents=True, exist_ok=True)

        output_template_str = "%(title)s.%(ext)s"

        if self.params.filename:
            output_template_str = f"{self.params.filename}.%(ext)s"

        if self.params.output_path:
            output_template_str = str(self.params.output_path / output_template_str)

        self._downloader_options = {
            "format": "best",
            "sleep_interval": 1,
            "max_sleep_interval": 5,
            "progress_hooks": [self._make_progress_hook()],
            "continuedl": True,
            "ignoreerrors": True,
            "extract_flat": "discard_in_playlist",
            "yes_playlist": True,
        }

    def _make_progress_hook(self):
        def _hook(d):
            if d["status"] == "finished":
                actual_filepath = Path(d["filename"])
                video_url = d.get("info_dict", {}).get(
                    "original_url", d.get("info_dict", {}).get("webpage_url")
                )
                video_title = d.get("info_dict", {}).get("title")
                video_yt_dlp_id = d.get("info_dict", {}).get("id")

                if video_url:
                    self._downloaded_files_session_cache[video_url] = actual_filepath
                    logger.info(
                        f"Download finished for {video_url}. Actual file: {actual_filepath}"
                    )
                    self.state_manager.add_or_update_media_item(
                        video_url=video_url,
                        title=video_title,
                        local_path=actual_filepath,
                        status=MediaStatus.DOWNLOADED,
                        yt_dlp_id=video_yt_dlp_id,
                    )
                else:
                    logger.warning(
                        f"Warning: Could not determine original URL for downloaded file {actual_filepath}. State may be incomplete."
                    )

            elif d["status"] == "error":
                video_url = d.get("info_dict", {}).get(
                    "original_url", d.get("info_dict", {}).get("webpage_url")
                )
                video_title = d.get("info_dict", {}).get("title")
                error_msg = str(d.get("error", "Unknown yt-dlp error"))
                logger.error(
                    f"Error downloading {video_url if video_url else 'unknown video'}: {error_msg}"
                )
                if video_url:
                    self.state_manager.add_or_update_media_item(
                        video_url=video_url,
                        title=video_title,
                        status=MediaStatus.FAILED_DOWNLOAD,
                        error_message=error_msg,
                    )

        return _hook

    @with_retry(
        max_attempts=3,
        initial_delay=1.0,
        max_delay=30.0,
        retryable_exceptions=(NetworkError,),
    )
    def _download_video(self, video_url: str) -> Optional[Path]:
        """Download a single video with retry logic."""
        try:
            ydl_opts = {
                "format": "best",
                "outtmpl": str(self.output_dir / "%(title)s.%(ext)s"),
                "progress_hooks": [self._make_progress_hook()],
            }

            with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                # First try to extract info to validate the URL
                try:
                    info = ydl.extract_info(video_url, download=False)
                    if not info:
                        raise ResourceNotFoundError(
                            f"Could not find video: {video_url}"
                        )
                except Exception as e:
                    if "Video unavailable" in str(e):
                        raise ResourceNotFoundError(f"Video unavailable: {video_url}")
                    elif "Private video" in str(e):
                        raise ValidationError(f"Private video: {video_url}")
                    else:
                        raise NetworkError(f"Failed to get video info: {str(e)}")

                # Update state to downloading
                self.state_manager.add_or_update_media_item(
                    video_url=video_url,
                    title=info.get("title"),
                    status=MediaStatus.DOWNLOADING,
                    yt_dlp_id=info.get("id"),
                )

                # Download the video
                ydl.download([video_url])

                # Get the local path from state manager
                return self.state_manager.get_local_path(video_url)

        except yt_dlp.utils.DownloadError as e:
            error_msg = str(e)
            if "Video unavailable" in error_msg:
                raise ResourceNotFoundError(f"Video unavailable: {video_url}")
            elif "Private video" in error_msg:
                raise ValidationError(f"Private video: {video_url}")
            else:
                raise NetworkError(f"Download failed: {error_msg}")
        except Exception as e:
            if isinstance(e, (ResourceNotFoundError, ValidationError)):
                raise
            raise NetworkError(f"Unexpected error during download: {str(e)}")

    def download_videos(self):
        urls_to_process = self.params.get_urls()
        num_urls = len(urls_to_process)
        output_base_path = self.params.output_path or Path.cwd()
        output_base_path.mkdir(parents=True, exist_ok=True)

        enabled_uploader_ids = [u.__class__.__name__ for u in self.uploaders]
        logger.info(f"Starting processing for {num_urls} URL(s).")

        with Progress(
            TextColumn("[progress.description]{task.description}"),
            BarColumn(),
            TextColumn("[progress.percentage]{task.percentage:>3.0f}%"),
            TextColumn("({task.completed} of {task.total})"),
            TimeRemainingColumn(),
            TimeElapsedColumn(),
            transient=False,
            console=None,
        ) as progress:
            overall_task = progress.add_task(
                "[green]Processing URLs...", total=num_urls
            )

            for i, url in enumerate(urls_to_process):
                logger.info(f"Processing URL ({i+1}/{num_urls}): {url}")
                processed_successfully_or_skipped = False
                try:
                    item_details = self.state_manager.get_media_item_details(url)
                    if (
                        item_details
                        and item_details.get("status") == MediaStatus.COMPLETED
                        and self.state_manager.is_video_processed_for_uploaders(
                            url, enabled_uploader_ids
                        )
                    ):
                        logger.info(
                            f"Skipping {url}: Already marked as COMPLETED for all enabled uploaders."
                        )
                        processed_successfully_or_skipped = True
                        continue

                    local_file_path: Optional[Path] = None
                    download_needed = True

                    if (
                        item_details
                        and item_details.get("local_path")
                        and Path(item_details["local_path"]).exists()
                        and item_details.get("status")
                        in [MediaStatus.DOWNLOADED, MediaStatus.UPLOAD_PENDING]
                    ):
                        local_file_path = Path(item_details["local_path"])
                        logger.info(
                            f"Found existing downloaded file for {url} at {local_file_path}. Will attempt to upload."
                        )
                        download_needed = False
                        self._downloaded_files_session_cache[url] = local_file_path
                    else:
                        logger.debug(f"Marking {url} for download (or re-download).")
                        self.state_manager.add_or_update_media_item(
                            video_url=url, status=MediaStatus.PENDING_DOWNLOAD
                        )

                    if download_needed:
                        logger.info(f"Downloading video from: {url}")
                        filename_template_part = "%(title)s.%(ext)s"
                        if len(urls_to_process) == 1 and self.params.filename:
                            filename_template_part = f"{self.params.filename}.%(ext)s"

                        current_dl_options = self._downloader_options.copy()
                        current_dl_options["outtmpl"] = str(
                            output_base_path / filename_template_part
                        )

                        try:
                            self._download_video(url)
                        except Exception as e:
                            logger.error(
                                f"Critical error during download for {url}: {e}",
                                exc_info=True,
                            )
                            self.state_manager.add_or_update_media_item(
                                video_url=url,
                                status=MediaStatus.FAILED_DOWNLOAD,
                                error_message=str(e),
                            )
                            continue

                    retrieved_local_file_path = (
                        self._downloaded_files_session_cache.get(url)
                    )

                    if (
                        not retrieved_local_file_path
                        or not retrieved_local_file_path.exists()
                    ):
                        db_path = self.state_manager.get_local_path(url)
                        if db_path and db_path.exists():
                            retrieved_local_file_path = db_path
                            logger.info(
                                f"Retrieved local file path from DB for {url}: {retrieved_local_file_path}"
                            )
                        else:
                            logger.warning(
                                f"Download failed or file not found for URL: {url}. Skipping uploads."
                            )
                            if not (
                                item_details
                                and item_details.get("status")
                                == MediaStatus.FAILED_DOWNLOAD
                            ):
                                self.state_manager.add_or_update_media_item(
                                    video_url=url,
                                    status=MediaStatus.FAILED_DOWNLOAD,
                                    error_message="File not found post-download attempt or hook failure.",
                                )
                            continue

                    local_file_path = retrieved_local_file_path
                    logger.info(
                        f"Proceeding with uploads for {local_file_path.name} (source: {url})"
                    )

                    if self.uploaders:
                        base_upload_filename = (
                            self.params.filename
                            if len(urls_to_process) == 1 and self.params.filename
                            else local_file_path.stem
                        )
                        logger.debug(
                            f"Found {len(self.uploaders)} uploader(s) configured for {url}."
                        )

                        for uploader_instance in self.uploaders:
                            uploader_id = uploader_instance.__class__.__name__
                            fresh_item_details = (
                                self.state_manager.get_media_item_details(url)
                            )
                            current_upload_status_from_db = (
                                (
                                    fresh_item_details.get("uploads", {})
                                    if fresh_item_details
                                    else {}
                                )
                                .get(uploader_id, {})
                                .get("status")
                            )

                            if current_upload_status_from_db == UploadStatus.SUCCESS:
                                logger.info(
                                    f"Skipping upload to {uploader_id} for {url}: Already marked as SUCCESS in DB."
                                )
                                continue

                            logger.info(
                                f"Attempting upload with {uploader_id} for {local_file_path.name}..."
                            )
                            self.state_manager.update_upload_status(
                                url, uploader_id, UploadStatus.PENDING
                            )
                            try:
                                target_hint = None
                                if hasattr(uploader_instance, "config"):
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

                                uploaded_cloud_id = uploader_instance.upload_video(
                                    local_path=local_file_path,
                                    desired_filename=base_upload_filename,
                                    target_location_hint=target_hint,
                                )
                                if uploaded_cloud_id:
                                    logger.info(
                                        f"Successfully uploaded to {uploader_id}. ID: {uploaded_cloud_id}"
                                    )
                                    self.state_manager.update_upload_status(
                                        url,
                                        uploader_id,
                                        UploadStatus.SUCCESS,
                                        uploaded_id=uploaded_cloud_id,
                                    )
                                else:
                                    logger.warning(
                                        f"Upload to {uploader_id} did not return an ID. Assuming failure or incomplete."
                                    )
                                    self.state_manager.update_upload_status(
                                        url,
                                        uploader_id,
                                        UploadStatus.FAILED,
                                        uploaded_id="FAILED_NO_ID",
                                    )
                            except Exception as e:
                                logger.error(
                                    f"Error during upload with {uploader_id} for {url}: {e}",
                                    exc_info=True,
                                )
                                self.state_manager.update_upload_status(
                                    url,
                                    uploader_id,
                                    UploadStatus.FAILED,
                                    uploaded_id=f"ERROR: {type(e).__name__}",
                                )
                    else:
                        logger.info(
                            f"No uploaders configured for {url}, skipping cloud upload."
                        )

                    processed_successfully_or_skipped = True

                except Exception as e_outer:
                    logger.error(
                        f"Unhandled exception while processing URL {url}: {e_outer}",
                        exc_info=True,
                    )
                    if not self.state_manager.get_media_item_details(url):
                        self.state_manager.add_or_update_media_item(
                            url,
                            status=MediaStatus.FAILED_DOWNLOAD,
                            error_message=f"Outer loop error: {str(e_outer)}",
                        )
                finally:
                    if processed_successfully_or_skipped or download_needed:
                        self.state_manager.update_item_status_if_all_uploads_done(
                            url, enabled_uploader_ids
                        )
                    progress.update(overall_task, advance=1)

        logger.info("All URL processing finished.")
