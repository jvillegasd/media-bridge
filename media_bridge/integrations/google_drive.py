from pathlib import Path
from typing import List, Optional

from google.oauth2.credentials import Credentials
from googleapiclient.discovery import build
from googleapiclient.http import MediaFileUpload


class GoogleDriveUploader:
    def __init__(self, credentials: Credentials):
        self.service = build("drive", "v3", credentials=credentials)

    def upload_file(self, file_path: Path, folder_id: Optional[str] = None) -> str:
        """
        Upload a file to Google Drive
        Args:
            file_path: Path to the file to upload
            folder_id: Optional folder ID to upload to (uploads to root if None)
        Returns:
            The file ID of the uploaded file
        """
        file_metadata = {"name": file_path.name}
        if folder_id:
            file_metadata["parents"] = [folder_id]

        media = MediaFileUpload(str(file_path), resumable=True)

        file = (
            self.service.files()
            .create(body=file_metadata, media_body=media, fields="id")
            .execute()
        )

        return file.get("id")

    def upload_files(
        self, file_paths: List[Path], folder_id: Optional[str] = None
    ) -> List[str]:
        """
        Upload multiple files to Google Drive
        Args:
            file_paths: List of paths to files to upload
            folder_id: Optional folder ID to upload to (uploads to root if None)
        Returns:
            List of file IDs for the uploaded files
        """
        return [self.upload_file(file_path, folder_id) for file_path in file_paths]
