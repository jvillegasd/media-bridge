import mimetypes
from pathlib import Path
from typing import Optional

import requests
from google.oauth2 import service_account
from google.oauth2.credentials import Credentials
from googleapiclient.discovery import build

from media_bridge.integrations.base import CloudStorageUploader
from media_bridge.schemas import GooglePhotosConfig


class GooglePhotosUploader(CloudStorageUploader):
    def __init__(self, config: GooglePhotosConfig):
        self.config = config
        self.service = None
        self.authenticate()

    def authenticate(self):
        """Authenticate with Google Photos API using the provided credentials"""
        if self.config.credentials_file.suffix.lower() == ".json":
            try:
                credentials = service_account.Credentials.from_service_account_file(
                    str(self.config.credentials_file),
                    scopes=["https://www.googleapis.com/auth/photoslibrary"],
                )
            except ValueError:
                # If it's not a service account, assume it's OAuth client credentials
                credentials = Credentials.from_authorized_user_file(
                    str(self.config.credentials_file),
                    scopes=["https://www.googleapis.com/auth/photoslibrary"],
                )
        else:
            raise ValueError(
                f"Unsupported credentials file format: {self.config.credentials_file}"
            )

        self.service = build("photoslibrary", "v1", credentials=credentials)
        self.credentials = credentials

    def _create_album_if_needed(self, album_name: str) -> str:
        """
        Create an album in Google Photos if it doesn't exist

        Args:
            album_name: Name of the album to create

        Returns:
            The album ID of the created or existing album
        """
        # List existing albums
        response = self.service.albums().list().execute()
        albums = response.get("albums", [])

        # Check if album with the same name already exists
        for album in albums:
            if album.get("title") == album_name:
                return album["id"]

        # Create a new album
        request_body = {"album": {"title": album_name}}
        response = self.service.albums().create(body=request_body).execute()
        return response["id"]

    def _upload_bytes(self, file_path: Path) -> Optional[str]:
        """
        Upload bytes to Google Photos to get an upload token

        Args:
            file_path: Path to the file to upload

        Returns:
            Upload token if successful, None otherwise
        """
        # Get the file's mime type
        mime_type, _ = mimetypes.guess_type(str(file_path))
        if not mime_type:
            mime_type = "application/octet-stream"

        # Get the upload URL
        upload_url = "https://photoslibrary.googleapis.com/v1/uploads"

        # Read the file data
        with open(file_path, "rb") as file:
            file_data = file.read()

        # Prepare headers for the upload request
        headers = {
            "Authorization": f"Bearer {self.credentials.token}",
            "Content-Type": "application/octet-stream",
            "X-Goog-Upload-Content-Type": mime_type,
            "X-Goog-Upload-Protocol": "raw",
        }

        # Make the upload request
        response = requests.post(upload_url, headers=headers, data=file_data)

        if response.status_code == 200:
            return response.text  # This is the upload token
        else:
            print(f"Error uploading bytes: {response.status_code} - {response.text}")
            return None

    def _create_media_item(
        self,
        upload_token: str,
        description: Optional[str] = None,
        album_id: Optional[str] = None,
    ) -> Optional[str]:
        """
        Create a media item in Google Photos using an upload token

        Args:
            upload_token: Upload token from _upload_bytes
            description: Optional description for the media item
            album_id: Optional album ID to add the media item to

        Returns:
            Media item ID if successful, None otherwise
        """
        request_body = {
            "newMediaItems": [{"simpleMediaItem": {"uploadToken": upload_token}}]
        }

        # Add description if provided
        if description:
            request_body["newMediaItems"][0]["description"] = description

        # If album_id is provided, add to album
        if album_id:
            request_body["albumId"] = album_id

        response = self.service.mediaItems().batchCreate(body=request_body).execute()

        if response.get("newMediaItemResults"):
            return response["newMediaItemResults"][0]["mediaItem"]["id"]

        return None

    def _archive_media_item(self, media_item_id: str) -> bool:
        """
        Archive a media item in Google Photos

        Args:
            media_item_id: ID of the media item to archive

        Returns:
            True if successful, False otherwise
        """
        body = {"mediaItemIds": [media_item_id]}
        try:
            # The batchAddToLibrary endpoint is used to archive media items
            self.service.mediaItems().batchAddToLibrary(body=body).execute()
            return True
        except Exception as e:
            print(f"Error archiving media item: {e}")
            return False

    def upload_video(
        self,
        local_path: Path,
        desired_filename: Optional[str] = None,
        target_location_hint: Optional[str] = None,
    ) -> str:
        """
        Upload a video to Google Photos

        Args:
            local_path: Path to the local video file
            desired_filename: Optional new filename for the video (without extension)
                              Due to Google Photos API limitations, this will be used as description instead.
            target_location_hint: Optional album ID to upload to

        Returns:
            The media item ID of the uploaded video
        """
        # Determine the album ID to use
        album_id = target_location_hint or self.config.target_album_id

        # If no album ID provided and create_album_if_not_exists is True, create a default album
        if not album_id and self.config.create_album_if_not_exists:
            album_id = self._create_album_if_needed("MediaBridge Uploads")

        # Determine the description to use
        description = None
        if self.config.rename_as_description and desired_filename:
            description = desired_filename

        # Upload the file bytes to get an upload token
        upload_token = self._upload_bytes(local_path)
        if not upload_token:
            raise RuntimeError(f"Failed to upload bytes for {local_path}")

        # Create the media item
        media_item_id = self._create_media_item(upload_token, description, album_id)
        if not media_item_id:
            raise RuntimeError(f"Failed to create media item for {local_path}")

        # Archive the media item if configured
        if self.config.archive_after_upload:
            success = self._archive_media_item(media_item_id)
            if not success:
                print(f"Warning: Failed to archive media item {media_item_id}")

        return media_item_id
