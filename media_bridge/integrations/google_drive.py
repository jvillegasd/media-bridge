import json
import logging
from pathlib import Path
from typing import Optional

from google.auth.exceptions import GoogleAuthError
from google.auth.transport.requests import Request
from google.oauth2.credentials import Credentials
from google_auth_oauthlib.flow import InstalledAppFlow
from googleapiclient.discovery import build
from googleapiclient.errors import HttpError
from googleapiclient.http import MediaFileUpload

from media_bridge.error_handler import (
    UploadConnectionError,
    UploadError,
    UploadFormatError,
    UploadPermissionError,
    UploadQuotaError,
    UploadRateLimitError,
    UploadSizeError,
    UploadTimeoutError,
)
from media_bridge.integrations.base import CloudStorageUploader

logger = logging.getLogger("media_bridge.uploader.google_drive")

# Google Drive specific constants
MAX_FILE_SIZE = 5 * 1024 * 1024 * 1024  # 5GB
SUPPORTED_FORMATS = {
    ".mp4": "video/mp4",
    ".avi": "video/x-msvideo",
    ".mov": "video/quicktime",
    ".wmv": "video/x-ms-wmv",
    ".flv": "video/x-flv",
    ".webm": "video/webm",
    ".mkv": "video/x-matroska",
}


class GoogleDriveUploader(CloudStorageUploader):
    """Google Drive uploader implementation."""

    def __init__(self, config: Optional[dict] = None):
        super().__init__(config)
        self.service = None
        self._initialize_service()

    def _save_credentials(self, creds: Credentials, token_path: Path) -> None:
        """Save credentials to a JSON file."""
        try:
            token_data = {
                "token": creds.token,
                "refresh_token": creds.refresh_token,
                "token_uri": creds.token_uri,
                "client_id": creds.client_id,
                "client_secret": creds.client_secret,
                "scopes": creds.scopes,
            }
            with open(token_path, "w") as token:
                json.dump(token_data, token)
        except Exception as e:
            logger.warning(f"Failed to save token file: {e}")

    def _load_credentials(self, token_path: Path) -> Optional[Credentials]:
        """Load credentials from a JSON file."""
        try:
            with open(token_path, "r") as token:
                token_data = json.load(token)
                return Credentials.from_authorized_user_info(token_data)
        except Exception as e:
            logger.warning(f"Failed to load token file: {e}. Will re-authenticate.")
            return None

    def _initialize_service(self) -> None:
        """Initialize Google Drive API service."""
        try:
            SCOPES = ["https://www.googleapis.com/auth/drive.file"]

            # Get paths from config
            credentials_path = self.config.get("credentials_file")
            token_path = self.config.get("token_file")

            if not credentials_path:
                raise UploadError(
                    "Google Drive credentials file path not provided in config"
                )

            # Convert to Path objects
            credentials_path = Path(credentials_path)
            token_path = (
                Path(token_path)
                if token_path
                else credentials_path.parent / "drive_token.json"
            )

            creds = None
            if token_path.exists():
                creds = self._load_credentials(token_path)

            if not creds or not creds.valid:
                if creds and creds.expired and creds.refresh_token:
                    try:
                        creds.refresh(Request())
                    except Exception as e:
                        logger.warning(
                            f"Failed to refresh token: {e}. Will re-authenticate."
                        )
                        creds = None

                if not creds:
                    if not credentials_path.exists():
                        raise UploadError(
                            f"Credentials file not found: {credentials_path}"
                        )

                    flow = InstalledAppFlow.from_client_secrets_file(
                        str(credentials_path), SCOPES
                    )
                    creds = flow.run_local_server(port=0)

                # Save the credentials
                self._save_credentials(creds, token_path)

            self.service = build("drive", "v3", credentials=creds)

        except GoogleAuthError as e:
            raise UploadPermissionError(
                f"Failed to authenticate with Google Drive: {str(e)}"
            )
        except Exception as e:
            raise UploadError(f"Failed to initialize Google Drive service: {str(e)}")

    def _validate_file(self, local_path: Path) -> None:
        """
        Validate the file before upload.

        Args:
            local_path: Path to the file to validate

        Raises:
            UploadFormatError: If file format is not supported
            UploadSizeError: If file size exceeds limits
        """
        # Check file format
        if local_path.suffix.lower() not in SUPPORTED_FORMATS:
            raise UploadFormatError(
                f"Unsupported file format: {local_path.suffix}. "
                f"Supported formats: {', '.join(SUPPORTED_FORMATS.keys())}"
            )

        # Check file size
        file_size = local_path.stat().st_size
        if file_size > MAX_FILE_SIZE:
            raise UploadSizeError(
                f"File size ({file_size / (1024*1024):.1f}MB) exceeds maximum allowed size "
                f"({MAX_FILE_SIZE / (1024*1024):.1f}MB)"
            )

    def _check_quota(self) -> None:
        """
        Check if upload quota is available.

        Raises:
            UploadQuotaError: If quota is exceeded
        """
        try:
            about = self.service.about().get(fields="storageQuota").execute()
            quota = about.get("storageQuota", {})

            if "limit" in quota and "usage" in quota:
                limit = int(quota["limit"])
                usage = int(quota["usage"])
                if usage >= limit:
                    raise UploadQuotaError(
                        f"Storage quota exceeded. Usage: {usage/(1024*1024):.1f}MB, "
                        f"Limit: {limit/(1024*1024):.1f}MB"
                    )
        except HttpError as e:
            if e.resp.status == 403:
                raise UploadQuotaError("Failed to check quota: Permission denied")
            raise UploadError(f"Failed to check quota: {str(e)}")
        except Exception as e:
            raise UploadError(f"Failed to check quota: {str(e)}")

    def _check_permissions(self) -> None:
        """
        Check if user has permission to upload.

        Raises:
            UploadPermissionError: If user lacks permission
        """
        try:
            # Try to list files to check permissions
            self.service.files().list(pageSize=1).execute()
        except HttpError as e:
            if e.resp.status == 403:
                raise UploadPermissionError(
                    "Permission denied: Cannot access Google Drive"
                )
            raise UploadError(f"Failed to check permissions: {str(e)}")
        except Exception as e:
            raise UploadError(f"Failed to check permissions: {str(e)}")

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
            target_location_hint: Optional folder ID to upload to

        Returns:
            Cloud storage ID of uploaded file

        Raises:
            UploadError: For general upload errors
            UploadTimeoutError: If upload times out
            UploadConnectionError: If connection fails
            UploadRateLimitError: If rate limit is hit
        """
        try:
            file_metadata = {
                "name": desired_filename,
                "mimeType": SUPPORTED_FORMATS[local_path.suffix.lower()],
            }

            if target_location_hint:
                file_metadata["parents"] = [target_location_hint]

            media = MediaFileUpload(
                str(local_path),
                mimetype=SUPPORTED_FORMATS[local_path.suffix.lower()],
                resumable=True,
            )

            file = (
                self.service.files()
                .create(body=file_metadata, media_body=media, fields="id")
                .execute()
            )

            return file.get("id")

        except HttpError as e:
            if e.resp.status == 403:
                raise UploadPermissionError(
                    "Permission denied: Cannot upload to Google Drive"
                )
            elif e.resp.status == 429:
                raise UploadRateLimitError("Rate limit exceeded: Too many requests")
            elif e.resp.status == 408:
                raise UploadTimeoutError("Upload timed out")
            elif e.resp.status in (500, 502, 503, 504):
                raise UploadConnectionError("Google Drive service unavailable")
            raise UploadError(f"Upload failed: {str(e)}")
        except Exception as e:
            if isinstance(
                e,
                (
                    UploadPermissionError,
                    UploadRateLimitError,
                    UploadTimeoutError,
                    UploadConnectionError,
                ),
            ):
                raise
            raise UploadError(f"Upload failed: {str(e)}")

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
