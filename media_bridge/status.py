from enum import Enum
from typing import Optional


class MediaStatus(Enum):
    """Status enum for media items."""

    PENDING_DOWNLOAD = "PENDING_DOWNLOAD"
    DOWNLOADED = "DOWNLOADED"
    UPLOAD_PENDING = "UPLOAD_PENDING"
    COMPLETED = "COMPLETED"
    FAILED_DOWNLOAD = "FAILED_DOWNLOAD"
    FAILED_UPLOAD = "FAILED_UPLOAD"

    @classmethod
    def from_str(cls, status_str: Optional[str]) -> Optional["MediaStatus"]:
        """Convert string to MediaStatus enum."""
        if not status_str:
            return None
        try:
            return cls(status_str)
        except ValueError:
            return None


class UploadStatus(Enum):
    """Status enum for upload operations."""

    PENDING = "PENDING"
    SUCCESS = "SUCCESS"
    FAILED = "FAILED"

    @classmethod
    def from_str(cls, status_str: Optional[str]) -> Optional["UploadStatus"]:
        """Convert string to UploadStatus enum."""
        if not status_str:
            return None
        try:
            return cls(status_str)
        except ValueError:
            return None
