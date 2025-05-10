import logging
from abc import ABC, abstractmethod
from pathlib import Path
from typing import Optional

from media_bridge.error_handler import UploadError, format_error_message, with_retry

logger = logging.getLogger("media_bridge.uploader")


class CloudStorageUploader(ABC):
    """Base class for cloud storage uploaders."""

    def __init__(self, config: Optional[dict] = None):
        self.config = config or {}

    @abstractmethod
    def _validate_file(self, local_path: Path) -> None:
        """
        Validate the file before upload.

        Args:
            local_path: Path to the file to validate

        Raises:
            UploadFormatError: If file format is not supported
            UploadSizeError: If file size exceeds limits
        """
        pass

    @abstractmethod
    def _check_quota(self) -> None:
        """
        Check if upload quota is available.

        Raises:
            UploadQuotaError: If quota is exceeded
        """
        pass

    @abstractmethod
    def _check_permissions(self) -> None:
        """
        Check if user has permission to upload.

        Raises:
            UploadPermissionError: If user lacks permission
        """
        pass

    @abstractmethod
    def _do_upload(
        self,
        local_path: Path,
        desired_filename: str,
        target_location_hint: Optional[str] = None,
    ) -> str:
        """
        Perform the actual upload.

        Args:
            local_path: Path to the file to upload
            desired_filename: Desired filename in cloud storage
            target_location_hint: Optional hint for target location (folder/album ID)

        Returns:
            Cloud storage ID of uploaded file

        Raises:
            UploadError: For general upload errors
            UploadTimeoutError: If upload times out
            UploadConnectionError: If connection fails
            UploadRateLimitError: If rate limit is hit
        """
        pass

    @with_retry(
        max_attempts=3,
        initial_delay=1.0,
        max_delay=30.0,
        retryable_exceptions=(UploadError,),
    )
    def upload_video(
        self,
        local_path: Path,
        desired_filename: str,
        target_location_hint: Optional[str] = None,
    ) -> Optional[str]:
        """
        Upload a video to cloud storage with retry logic.

        Args:
            local_path: Path to the video file
            desired_filename: Desired filename in cloud storage
            target_location_hint: Optional hint for target location (folder/album ID)

        Returns:
            Cloud storage ID of uploaded file, or None if upload failed

        Raises:
            UploadFormatError: If file format is not supported
            UploadSizeError: If file size exceeds limits
            UploadQuotaError: If quota is exceeded
            UploadPermissionError: If user lacks permission
            UploadError: For general upload errors
            UploadTimeoutError: If upload times out
            UploadConnectionError: If connection fails
            UploadRateLimitError: If rate limit is hit
        """
        try:
            # Validate file
            self._validate_file(local_path)

            # Check quota
            self._check_quota()

            # Check permissions
            self._check_permissions()

            # Perform upload
            return self._do_upload(local_path, desired_filename, target_location_hint)

        except Exception as e:
            logger.error(format_error_message(e, include_traceback=True))
            raise
