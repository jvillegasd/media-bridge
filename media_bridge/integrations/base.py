from abc import ABC, abstractmethod
from pathlib import Path
from typing import Optional


class CloudStorageUploader(ABC):
    @abstractmethod
    def authenticate(self):
        """Authenticate with the cloud storage service"""
        pass

    @abstractmethod
    def upload_video(
        self,
        local_path: Path,
        desired_filename: Optional[str] = None,
        target_location_hint: Optional[str] = None,
    ) -> str:
        """
        Upload a video to the cloud storage

        Args:
            local_path: Path to the local video file
            desired_filename: Optional new filename for the video (without extension)
            target_location_hint: Optional target location (folder ID, album ID etc.)

        Returns:
            Identifier for the uploaded file in the cloud storage
        """
        pass
