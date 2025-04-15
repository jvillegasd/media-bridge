from pathlib import Path
from typing import List, Optional

from google.oauth2 import service_account
from google.oauth2.credentials import Credentials
from googleapiclient.discovery import build
from googleapiclient.http import MediaFileUpload

from media_bridge.integrations.base import CloudStorageUploader
from media_bridge.schemas import GoogleDriveConfig


class GoogleDriveUploader(CloudStorageUploader):
    def __init__(self, config: GoogleDriveConfig):
        self.config = config
        self.service = None
        self.authenticate()

    def authenticate(self):
        """Authenticate with Google Drive API using the provided credentials"""
        # Check if the credentials file is a service account or OAuth client credentials
        if self.config.credentials_file.suffix.lower() == ".json":
            try:
                credentials = service_account.Credentials.from_service_account_file(
                    str(self.config.credentials_file),
                    scopes=["https://www.googleapis.com/auth/drive"],
                )
            except ValueError:
                # If it's not a service account, assume it's OAuth client credentials
                credentials = Credentials.from_authorized_user_file(
                    str(self.config.credentials_file),
                    scopes=["https://www.googleapis.com/auth/drive"],
                )
        else:
            raise ValueError(
                f"Unsupported credentials file format: {self.config.credentials_file}"
            )

        self.service = build("drive", "v3", credentials=credentials)

    def _create_folder_if_needed(self, folder_name: str) -> str:
        """
        Create a folder in Google Drive if it doesn't exist

        Args:
            folder_name: Name of the folder to create

        Returns:
            The folder ID of the created or existing folder
        """
        # Search for existing folders with the same name
        query = f"mimeType='application/vnd.google-apps.folder' and name='{folder_name}' and trashed=false"
        response = (
            self.service.files()
            .list(q=query, spaces="drive", fields="files(id, name)")
            .execute()
        )

        if response.get("files"):
            # Return the first matching folder
            return response["files"][0]["id"]

        # If no matching folder, create a new one
        folder_metadata = {
            "name": folder_name,
            "mimeType": "application/vnd.google-apps.folder",
        }

        folder = (
            self.service.files().create(body=folder_metadata, fields="id").execute()
        )
        return folder.get("id")

    def upload_video(
        self,
        local_path: Path,
        desired_filename: Optional[str] = None,
        target_location_hint: Optional[str] = None,
    ) -> str:
        """
        Upload a video to Google Drive

        Args:
            local_path: Path to the local video file
            desired_filename: Optional new filename for the video (without extension)
            target_location_hint: Optional folder ID to upload to

        Returns:
            The file ID of the uploaded file
        """
        # Determine the folder ID to use
        folder_id = target_location_hint or self.config.target_folder_id

        # If no folder ID provided and create_folder_if_not_exists is True, create a default folder
        if not folder_id and self.config.create_folder_if_not_exists:
            folder_id = self._create_folder_if_needed("MediaBridge Uploads")

        # Determine the filename to use
        if desired_filename:
            # Keep the original extension
            file_ext = local_path.suffix
            filename = f"{desired_filename}{file_ext}"
        elif self.config.rename_pattern:
            # Apply renaming pattern
            # Simple implementation - future enhancement could include placeholders like {date}, {source}, etc.
            file_ext = local_path.suffix
            filename = f"{self.config.rename_pattern}{file_ext}"
        else:
            filename = local_path.name

        # Build file metadata
        file_metadata = {"name": filename}
        if folder_id:
            file_metadata["parents"] = [folder_id]

        # Upload the file
        media = MediaFileUpload(str(local_path), resumable=True)

        file = (
            self.service.files()
            .create(body=file_metadata, media_body=media, fields="id")
            .execute()
        )

        return file.get("id")

    # Keep the legacy methods for backwards compatibility
    def upload_file(self, file_path: Path, folder_id: Optional[str] = None) -> str:
        return self.upload_video(file_path, target_location_hint=folder_id)

    def upload_files(
        self, file_paths: List[Path], folder_id: Optional[str] = None
    ) -> List[str]:
        return [
            self.upload_video(file_path, target_location_hint=folder_id)
            for file_path in file_paths
        ]
