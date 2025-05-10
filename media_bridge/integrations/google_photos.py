import logging
import mimetypes
from pathlib import Path
from typing import Optional

import requests
from google.auth.exceptions import GoogleAuthError
from google.auth.transport.requests import AuthorizedSession
from google.auth.transport.requests import Request as GoogleAuthRequest
from google.oauth2.credentials import Credentials
from google_auth_oauthlib.flow import InstalledAppFlow
from googleapiclient.discovery import build
from googleapiclient.errors import HttpError

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
from media_bridge.schemas import GooglePhotosConfig

logger = logging.getLogger("media_bridge.google_photos")

# Google Photos specific constants
MAX_FILE_SIZE = 10 * 1024 * 1024 * 1024  # 10GB (Google Photos limit)
SUPPORTED_FORMATS = {
    ".mp4": "video/mp4",
    ".avi": "video/x-msvideo",
    ".mov": "video/quicktime",
    ".wmv": "video/x-ms-wmv",
    ".flv": "video/x-flv",
    ".webm": "video/webm",
    ".mkv": "video/x-matroska",
}


class GooglePhotosUploader(CloudStorageUploader):
    # Use read/write scope as we need to upload and create albums
    SCOPES = ["https://www.googleapis.com/auth/photoslibrary"]

    def __init__(self, config: GooglePhotosConfig):
        self.config = config
        self.service = None
        self.credentials = None
        logger.debug(
            "GooglePhotosUploader instance created. Attempting authentication..."
        )
        self.authenticate()

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
            response = self.service.mediaItems().list(pageSize=1).execute()
            # If we can list items, we have access
            if "mediaItems" not in response:
                raise UploadQuotaError("Failed to check quota: Invalid response")
        except HttpError as e:
            if e.resp.status == 403:
                raise UploadQuotaError("Failed to check quota: Permission denied")
            elif e.resp.status == 429:
                raise UploadRateLimitError("Rate limit exceeded: Too many requests")
            raise UploadError(f"Failed to check quota: {str(e)}")
        except Exception as e:
            raise UploadError(f"Failed to check quota: {str(e)}")

    def authenticate(self):
        """Authenticate with Google Photos API using OAuth 2.0 flow."""
        try:
            creds = None
            token_path = (
                self.config.token_file
                or Path(self.config.credentials_file).parent / "photos_token.json"
            )

            if token_path.exists():
                try:
                    creds = Credentials.from_authorized_user_file(
                        str(token_path), self.SCOPES
                    )
                except Exception as e:
                    logger.warning(
                        f"Failed to load token file: {e}. Will re-authenticate."
                    )

            if not creds or not creds.valid:
                if creds and creds.expired and creds.refresh_token:
                    try:
                        creds.refresh(GoogleAuthRequest())
                        logger.info("Google Photos token refreshed successfully.")
                    except Exception as e:
                        logger.warning(
                            f"Error refreshing Photos token: {e}. Need to re-authenticate.",
                            exc_info=True,
                        )
                        creds = None
                else:
                    if not self.config.credentials_file.exists():
                        raise UploadError(
                            f"Credentials file not found: {self.config.credentials_file}. "
                            "Please provide the path to your OAuth Client ID JSON file."
                        )
                    logger.info("Performing Google Photos OAuth flow...")
                    flow = InstalledAppFlow.from_client_secrets_file(
                        str(self.config.credentials_file), self.SCOPES
                    )
                    creds = flow.run_local_server(port=0)
                    logger.info("Google Photos OAuth flow completed.")

                try:
                    with open(token_path, "w") as token:
                        token.write(creds.to_json())
                    logger.info(
                        f"Photos authentication successful. Token saved to: {token_path}"
                    )
                except Exception as e:
                    logger.warning(f"Failed to save token file: {e}")

            self.credentials = creds
            try:
                # Build the service with static_discovery=False for Photos API
                self.service = build(
                    "photoslibrary",
                    "v1",
                    credentials=self.credentials,
                    static_discovery=False,
                )
                logger.info("Google Photos API service created successfully.")
            except HttpError as error:
                if error.resp.status == 403:
                    raise UploadPermissionError(
                        "Failed to access Google Photos: Permission denied"
                    )
                elif error.resp.status == 429:
                    raise UploadRateLimitError("Rate limit exceeded: Too many requests")
                raise UploadError(f"Failed to build Photos service: {str(error)}")
            except Exception as e:
                raise UploadError(f"Failed to build Photos service: {str(e)}")

        except GoogleAuthError as e:
            raise UploadPermissionError(
                f"Failed to authenticate with Google Photos: {str(e)}"
            )
        except Exception as e:
            if isinstance(
                e, (UploadPermissionError, UploadRateLimitError, UploadError)
            ):
                raise
            raise UploadError(f"Failed to initialize Google Photos service: {str(e)}")

    def _create_album_if_needed(self, album_name: str) -> Optional[str]:
        """
        Create an album in Google Photos if it doesn't exist

        Args:
            album_name: Name of the album to create

        Returns:
            The album ID of the created or existing album, or None on failure.
        """
        if not self.service:
            logger.warning("Google Photos service not available, cannot create album.")
            return None
        try:
            # List existing albums
            response = (
                self.service.albums().list(pageSize=50).execute()
            )  # Limit page size
            albums = response.get("albums", [])

            # Check if album with the same name already exists
            for album in albums:
                if album.get("title") == album_name:
                    logger.debug(
                        f"Found existing album '{album_name}' with ID: {album['id']}"
                    )
                    return album["id"]

            # Create a new album
            logger.info(f"Creating new Google Photos album: {album_name}")
            request_body = {"album": {"title": album_name}}
            response = self.service.albums().create(body=request_body).execute()
            album_id = response["id"]
            logger.info(f"Created album '{album_name}' with ID: {album_id}")
            return album_id
        except HttpError as error:
            logger.error(
                f"An error occurred interacting with Google Photos albums for '{album_name}': {error}",
                exc_info=True,
            )
            return None
        except Exception as e:
            logger.error(
                f"An unexpected error occurred creating album '{album_name}': {e}",
                exc_info=True,
            )
            return None

    def _upload_bytes(self, file_path: Path) -> Optional[str]:
        """
        Upload bytes to Google Photos to get an upload token using authenticated session.

        Args:
            file_path: Path to the file to upload

        Returns:
            Upload token if successful, None otherwise

        Raises:
            UploadError: For general upload errors
            UploadTimeoutError: If upload times out
            UploadConnectionError: If connection fails
            UploadRateLimitError: If rate limit is hit
        """
        if not self.credentials or not self.credentials.valid:
            raise UploadPermissionError("Authentication required or token invalid")

        # Get the file's mime type
        mime_type, _ = mimetypes.guess_type(str(file_path))
        if not mime_type:
            mime_type = "application/octet-stream"
            logger.debug(
                f"Could not guess mime type for {file_path.name}, using default: {mime_type}"
            )

        upload_url = "https://photoslibrary.googleapis.com/v1/uploads"
        authed_session = AuthorizedSession(self.credentials)

        try:
            with open(file_path, "rb") as file_data:
                headers = {
                    "Content-Type": "application/octet-stream",
                    "X-Goog-Upload-Content-Type": mime_type,
                    "X-Goog-Upload-Protocol": "raw",
                    "X-Goog-Upload-File-Name": file_path.name,
                }
                logger.info(
                    f"Uploading bytes for {file_path.name} ({mime_type}) to Google Photos..."
                )
                response = authed_session.post(
                    upload_url, headers=headers, data=file_data
                )
                response.raise_for_status()
                upload_token = response.text
                logger.info(
                    f"Google Photos byte upload successful for {file_path.name}. Token: {upload_token[:10]}...{upload_token[-10:]}"
                )
                return upload_token
        except requests.exceptions.Timeout:
            raise UploadTimeoutError("Upload timed out")
        except requests.exceptions.ConnectionError:
            raise UploadConnectionError("Failed to connect to Google Photos")
        except requests.exceptions.HTTPError as e:
            if e.response.status_code == 429:
                raise UploadRateLimitError("Rate limit exceeded: Too many requests")
            elif e.response.status_code == 403:
                raise UploadPermissionError(
                    "Permission denied: Cannot upload to Google Photos"
                )
            raise UploadError(f"Upload failed: {str(e)}")
        except Exception as e:
            raise UploadError(f"Upload failed: {str(e)}")

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

        Raises:
            UploadError: For general upload errors
            UploadPermissionError: If user lacks permission
            UploadRateLimitError: If rate limit is hit
        """
        if not self.service:
            raise UploadError("Google Photos service not available")

        request_body = {
            "newMediaItems": [{"simpleMediaItem": {"uploadToken": upload_token}}]
        }

        if description:
            request_body["newMediaItems"][0]["description"] = description

        if album_id:
            request_body["albumId"] = album_id

        try:
            response = (
                self.service.mediaItems().batchCreate(body=request_body).execute()
            )
            results = response.get("newMediaItemResults", [])

            if not results:
                raise UploadError("No results returned from media item creation")

            item_result = results[0]
            status = item_result.get("status", {})

            if status.get("message") != "Success":
                error_message = status.get("message", "Unknown error")
                if "PERMISSION_DENIED" in error_message:
                    raise UploadPermissionError(f"Permission denied: {error_message}")
                elif "RESOURCE_EXHAUSTED" in error_message:
                    raise UploadRateLimitError(f"Rate limit exceeded: {error_message}")
                raise UploadError(f"Media item creation failed: {error_message}")

            media_item = item_result.get("mediaItem")
            if not media_item or not media_item.get("id"):
                raise UploadError("Media item created but no ID returned")

            return media_item["id"]

        except HttpError as e:
            if e.resp.status == 403:
                raise UploadPermissionError(
                    "Permission denied: Cannot create media item"
                )
            elif e.resp.status == 429:
                raise UploadRateLimitError("Rate limit exceeded: Too many requests")
            raise UploadError(f"Failed to create media item: {str(e)}")
        except Exception as e:
            if isinstance(
                e, (UploadPermissionError, UploadRateLimitError, UploadError)
            ):
                raise
            raise UploadError(f"Failed to create media item: {str(e)}")

    def _archive_media_item(self, media_item_id: str) -> bool:
        """
        Archive a media item in Google Photos

        Args:
            media_item_id: ID of the media item to archive

        Returns:
            True if successful, False otherwise
        """
        # Note: Archiving requires the photoslibrary.edit scope, which we have.
        # The actual API call for archiving seems complex or undocumented via standard client.
        # Google's docs suggest using the web UI or Android app.
        # There is no direct 'archive' method in the discovery document.
        # Some unofficial sources suggest undocumented API endpoints or methods.
        # For now, we cannot reliably implement archiving via the public API.
        logger.warning(
            f"Archiving media item {media_item_id} in Google Photos is not currently supported via the API."
        )
        return False
        # if not self.service:
        #     print("Google Photos service not available.")
        #     return False
        #
        # body = {"mediaItemIds": [media_item_id]}
        # try:
        #     # Attempt using a potentially non-standard or older method (needs verification)
        #     # This specific batch operation might not perform archiving.
        #     self.service.mediaItems().batchUpdate(body=body).execute() # This might be incorrect
        #     print(f"Attempted to archive media item: {media_item_id}")
        #     return True # Assume success if no error, but verify behavior
        # except HttpError as error:
        #     print(f"Error archiving media item (HttpError): {error}")
        #     return False
        # except Exception as e:
        #     print(f"Error archiving media item (Exception): {e}")
        #     return False

    def upload_video(
        self,
        local_path: Path,
        desired_filename: Optional[str] = None,
        target_location_hint: Optional[str] = None,
    ) -> Optional[str]:
        """
        Upload a video to Google Photos

        Args:
            local_path: Path to the local video file
            desired_filename: Optional new filename for the video (without extension)
                              Due to Google Photos API limitations, this will be used as description instead.
            target_location_hint: Optional album ID to upload to

        Returns:
            The media item ID of the uploaded video, or None if failed

        Raises:
            UploadError: For general upload errors
            UploadFormatError: If file format is not supported
            UploadSizeError: If file size exceeds limits
            UploadPermissionError: If user lacks permission
            UploadQuotaError: If quota is exceeded
            UploadRateLimitError: If rate limit is hit
            UploadTimeoutError: If upload times out
            UploadConnectionError: If connection fails
        """
        try:
            # Validate file
            self._validate_file(local_path)

            # Check quota
            self._check_quota()

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
            logger.info(f"Starting Google Photos upload process for: {local_path.name}")
            upload_token = self._upload_bytes(local_path)
            if not upload_token:
                raise UploadError(f"Failed to get upload token for {local_path.name}")

            # Create the media item
            media_item_id = self._create_media_item(upload_token, description, album_id)
            if not media_item_id:
                raise UploadError(f"Failed to create media item for {local_path.name}")

            # Archive the media item if configured
            if self.config.archive_after_upload:
                logger.info(
                    f"Archiving configured for Google Photos item {media_item_id}..."
                )
                archived = self._archive_media_item(media_item_id)
                if not archived:
                    logger.warning(
                        f"Failed to archive Google Photos media item {media_item_id}. It remains in the library."
                    )
                else:
                    logger.info(
                        f"Google Photos media item {media_item_id} archived successfully."
                    )

            return media_item_id

        except Exception as e:
            if isinstance(
                e,
                (
                    UploadError,
                    UploadFormatError,
                    UploadSizeError,
                    UploadPermissionError,
                    UploadQuotaError,
                    UploadRateLimitError,
                    UploadTimeoutError,
                    UploadConnectionError,
                ),
            ):
                raise
            raise UploadError(f"Failed to upload video to Google Photos: {str(e)}")
