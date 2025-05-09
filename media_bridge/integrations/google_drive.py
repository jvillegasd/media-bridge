import logging
from pathlib import Path
from typing import Optional

from google.auth.transport.requests import Request
from google.oauth2.credentials import Credentials
from google_auth_oauthlib.flow import InstalledAppFlow
from googleapiclient.discovery import build
from googleapiclient.errors import HttpError
from googleapiclient.http import MediaFileUpload

from media_bridge.integrations.base import CloudStorageUploader
from media_bridge.schemas import GoogleDriveConfig

logger = logging.getLogger("media_bridge.google_drive")


class GoogleDriveUploader(CloudStorageUploader):
    SCOPES = ["https://www.googleapis.com/auth/drive"]

    def __init__(self, config: GoogleDriveConfig):
        self.config = config
        self.service = None
        self.credentials = None
        logger.debug(
            "GoogleDriveUploader instance created. Attempting authentication..."
        )
        self.authenticate()

    def authenticate(self):
        """Authenticate with Google Drive API using OAuth 2.0 flow."""
        creds = None
        # Determine the token file path
        token_path = (
            self.config.token_file
            or Path(self.config.credentials_file).parent / "drive_token.json"
        )

        # The file token_path stores the user's access and refresh tokens, and is
        # created automatically when the authorization flow completes for the first time.
        if token_path.exists():
            creds = Credentials.from_authorized_user_file(str(token_path), self.SCOPES)

        # If there are no (valid) credentials available, let the user log in.
        if not creds or not creds.valid:
            if creds and creds.expired and creds.refresh_token:
                try:
                    creds.refresh(Request())
                    logger.info("Google Drive token refreshed successfully.")
                except Exception as e:
                    logger.warning(
                        f"Error refreshing Google Drive token: {e}. Need to re-authenticate.",
                        exc_info=True,
                    )
                    creds = None  # Force re-authentication
            else:
                if not self.config.credentials_file.exists():
                    logger.error(
                        f"Credentials file not found: {self.config.credentials_file}"
                    )
                    raise FileNotFoundError(
                        f"Credentials file not found: {self.config.credentials_file}. "
                        "Please provide the path to your OAuth Client ID JSON file."
                    )
                logger.info("Performing Google Drive OAuth flow...")
                flow = InstalledAppFlow.from_client_secrets_file(
                    str(self.config.credentials_file), self.SCOPES
                )
                creds = flow.run_local_server(port=0)
                logger.info("Google Drive OAuth flow completed.")

            # Save the credentials for the next run
            with open(token_path, "w") as token:
                token.write(creds.to_json())
            logger.info(
                f"Google Drive authentication successful. Token saved to: {token_path}"
            )

        self.credentials = creds
        try:
            self.service = build("drive", "v3", credentials=self.credentials)
            logger.info("Google Drive API service created successfully.")
        except HttpError as error:
            logger.error(
                f"An error occurred building the Drive service: {error}", exc_info=True
            )
            self.service = None
        except Exception as e:
            logger.error(
                f"An unexpected error occurred building the Drive service: {e}",
                exc_info=True,
            )
            self.service = None

    def _create_folder_if_needed(self, folder_name: str) -> Optional[str]:
        """
        Create a folder in Google Drive if it doesn't exist

        Args:
            folder_name: Name of the folder to create

        Returns:
            The folder ID of the created or existing folder, or None if creation failed
        """
        # Add check for service existence
        if not self.service:
            logger.warning("Google Drive service not available, cannot create folder.")
            return None

        # Search for existing folders with the same name
        query = f"mimeType='application/vnd.google-apps.folder' and name='{folder_name}' and trashed=false"
        try:
            response = (
                self.service.files()
                .list(q=query, spaces="drive", fields="files(id, name)")
                .execute()
            )
        except HttpError as error:
            logger.error(
                f"An error occurred searching for folder '{folder_name}': {error}",
                exc_info=True,
            )
            return None

        if response.get("files"):
            # Return the first matching folder
            return response["files"][0]["id"]

        # If no matching folder, create a new one
        folder_metadata = {
            "name": folder_name,
            "mimeType": "application/vnd.google-apps.folder",
        }

        # Handle potential error during folder creation
        try:
            folder = (
                self.service.files().create(body=folder_metadata, fields="id").execute()
            )
            logger.debug(
                f"Folder '{folder_name}' (ID: {folder.get('id') if folder else 'N/A'}) ensured."
            )
            return folder.get("id") if folder else None
        except HttpError as error:
            logger.error(
                f"An error occurred creating folder '{folder_name}': {error}",
                exc_info=True,
            )
            return None

    def upload_video(
        self,
        local_path: Path,
        desired_filename: Optional[str] = None,
        target_location_hint: Optional[str] = None,
    ) -> Optional[str]:  # Return Optional[str] as upload can fail
        """
        Upload a video to Google Drive

        Args:
            local_path: Path to the local video file
            desired_filename: Optional new filename for the video (without extension)
            target_location_hint: Optional folder ID to upload to

        Returns:
            The file ID of the uploaded file, or None if upload failed.
        """
        # Check if service is available
        if not self.service:
            logger.warning("Google Drive service not available. Cannot upload.")
            return None

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
        else:
            logger.debug(
                f"No target folder specified for Google Drive upload of {filename}. Will upload to root (if no default creation). "
            )

        # Upload the file
        logger.info(
            f"Starting upload of {local_path.name} to Google Drive as {filename}..."
        )
        media = MediaFileUpload(str(local_path), resumable=True)

        try:
            file = (
                self.service.files()
                .create(body=file_metadata, media_body=media, fields="id")
                .execute()
            )
            file_id = file.get("id")
            logger.info(
                f"Successfully uploaded {filename} to Google Drive. File ID: {file_id}"
            )
            return file_id
        except HttpError as error:
            logger.error(
                f"An error occurred during Google Drive upload of {filename}: {error}",
                exc_info=True,
            )
            return None
        except Exception as e:
            logger.error(
                f"An unexpected error occurred during Google Drive upload of {filename}: {e}",
                exc_info=True,
            )
            return None

    # Remove legacy methods
    # def upload_file(self, file_path: Path, folder_id: Optional[str] = None) -> str:
    #     return self.upload_video(file_path, target_location_hint=folder_id)
    #
    # def upload_files(
    #     self, file_paths: List[Path], folder_id: Optional[str] = None
    # ) -> List[str]:
    #     return [
    #         self.upload_video(file_path, target_location_hint=folder_id)
    #         for file_path in file_paths
    #     ]
