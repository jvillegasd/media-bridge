import mimetypes
from pathlib import Path
from typing import Optional

import requests

# Use AuthorizedSession for uploads
# Use google-auth-requests-session for authenticated HTTP requests
from google.auth.transport.requests import AuthorizedSession
from google.auth.transport.requests import Request as GoogleAuthRequest
from google.oauth2.credentials import Credentials
from google_auth_oauthlib.flow import InstalledAppFlow
from googleapiclient.discovery import build
from googleapiclient.errors import HttpError

from media_bridge.integrations.base import CloudStorageUploader
from media_bridge.schemas import GooglePhotosConfig


class GooglePhotosUploader(CloudStorageUploader):
    # Use read/write scope as we need to upload and create albums
    SCOPES = ["https://www.googleapis.com/auth/photoslibrary"]

    def __init__(self, config: GooglePhotosConfig):
        self.config = config
        self.service = None
        self.credentials = None
        self.authenticate()

    def authenticate(self):
        """Authenticate with Google Photos API using OAuth 2.0 flow."""
        creds = None
        token_path = (
            self.config.token_file
            or Path(self.config.credentials_file).parent / "photos_token.json"
        )

        if token_path.exists():
            creds = Credentials.from_authorized_user_file(str(token_path), self.SCOPES)

        if not creds or not creds.valid:
            if creds and creds.expired and creds.refresh_token:
                try:
                    creds.refresh(GoogleAuthRequest())
                except Exception as e:
                    print(
                        f"Error refreshing Photos token: {e}. Need to re-authenticate."
                    )
                    creds = None
            else:
                if not self.config.credentials_file.exists():
                    raise FileNotFoundError(
                        f"Credentials file not found: {self.config.credentials_file}. "
                        "Please provide the path to your OAuth Client ID JSON file."
                    )
                flow = InstalledAppFlow.from_client_secrets_file(
                    str(self.config.credentials_file), self.SCOPES
                )
                creds = flow.run_local_server(port=0)

            with open(token_path, "w") as token:
                token.write(creds.to_json())
            print(f"Photos authentication successful. Token saved to: {token_path}")

        self.credentials = creds
        try:
            # Build the service with static_discovery=False for Photos API
            self.service = build(
                "photoslibrary",
                "v1",
                credentials=self.credentials,
                static_discovery=False,
            )
            print("Google Photos API service created successfully.")
        except HttpError as error:
            print(f"An error occurred building the Photos service: {error}")
            self.service = None
        except Exception as e:
            print(f"An unexpected error occurred building the Photos service: {e}")
            self.service = None

    def _create_album_if_needed(self, album_name: str) -> Optional[str]:
        """
        Create an album in Google Photos if it doesn't exist

        Args:
            album_name: Name of the album to create

        Returns:
            The album ID of the created or existing album, or None on failure.
        """
        if not self.service:
            print("Google Photos service not available.")
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
                    print(f"Found existing album '{album_name}' with ID: {album['id']}")
                    return album["id"]

            # Create a new album
            print(f"Creating new album: {album_name}")
            request_body = {"album": {"title": album_name}}
            response = self.service.albums().create(body=request_body).execute()
            album_id = response["id"]
            print(f"Created album '{album_name}' with ID: {album_id}")
            return album_id
        except HttpError as error:
            print(f"An error occurred interacting with albums: {error}")
            return None
        except Exception as e:
            print(f"An unexpected error occurred creating album: {e}")
            return None

    def _upload_bytes(self, file_path: Path) -> Optional[str]:
        """
        Upload bytes to Google Photos to get an upload token using authenticated session.

        Args:
            file_path: Path to the file to upload

        Returns:
            Upload token if successful, None otherwise
        """
        if not self.credentials or not self.credentials.valid:
            print("Authentication required or token expired. Please re-authenticate.")
            # Attempt refresh if possible
            if self.credentials and self.credentials.refresh_token:
                try:
                    self.credentials.refresh(GoogleAuthRequest())
                except Exception as e:
                    print(f"Failed to refresh token during upload: {e}")
                    return None
            else:
                return None  # Cannot proceed without valid credentials

        # Get the file's mime type
        mime_type, _ = mimetypes.guess_type(str(file_path))
        if not mime_type:
            mime_type = "application/octet-stream"
            print(
                f"Could not guess mime type for {file_path.name}, using default: {mime_type}"
            )

        upload_url = "https://photoslibrary.googleapis.com/v1/uploads"
        authed_session = AuthorizedSession(self.credentials)

        try:
            with open(file_path, "rb") as file_data:
                headers = {
                    # Auth is handled by AuthorizedSession
                    "Content-Type": "application/octet-stream",
                    "X-Goog-Upload-Content-Type": mime_type,
                    "X-Goog-Upload-Protocol": "raw",
                    # Consider adding filename for debugging/logging on Google's side
                    "X-Goog-Upload-File-Name": file_path.name,
                }
                print(f"Uploading bytes for {file_path.name} ({mime_type})...")
                response = authed_session.post(
                    upload_url, headers=headers, data=file_data
                )
                response.raise_for_status()  # Raises HTTPError for bad responses (4xx or 5xx)
                upload_token = response.text
                print(
                    f"Byte upload successful. Token: {upload_token[:10]}...{upload_token[-10:]}"
                )  # Avoid printing full token
                return upload_token
        except HttpError as error:
            print(
                f"Error uploading bytes (HttpError): {error.resp.status} - {error.content}"
            )
            return None
        except requests.exceptions.RequestException as error:
            print(f"Error uploading bytes (RequestException): {error}")
            return None
        except Exception as e:
            print(f"An unexpected error occurred during byte upload: {e}")
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
        if not self.service:
            print("Google Photos service not available.")
            return None

        request_body = {
            "newMediaItems": [{"simpleMediaItem": {"uploadToken": upload_token}}]
        }

        # Add description if provided
        if description:
            request_body["newMediaItems"][0]["description"] = description

        # If album_id is provided, add to album
        if album_id:
            request_body["albumId"] = album_id

        print(f"Creating media item with token {upload_token[:10]}...", end="")
        if album_id:
            print(f" in album {album_id}", end="")
        if description:
            print(f" with description '{description}'", end="")
        print(".")

        try:
            response = (
                self.service.mediaItems().batchCreate(body=request_body).execute()
            )

            # Check the response structure carefully
            results = response.get("newMediaItemResults")
            if results and len(results) > 0:
                item_result = results[0]
                # Check for errors reported by the API for this specific item
                status = item_result.get("status")
                if status and status.get("message") == "Success":
                    media_item = item_result.get("mediaItem")
                    if media_item and media_item.get("id"):
                        media_item_id = media_item["id"]
                        print(f"Successfully created media item. ID: {media_item_id}")
                        return media_item_id
                    else:
                        print(
                            f"Media item creation reported success, but no ID found in response: {item_result}"
                        )
                        return None
                else:
                    print(f"Media item creation failed. Status: {status}")
                    return None
            else:
                print(
                    f"Media item creation failed. Unexpected response format: {response}"
                )
                return None
        except HttpError as error:
            print(f"An error occurred creating media item: {error}")
            return None
        except Exception as e:
            print(f"An unexpected error occurred creating media item: {e}")
            return None

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
        print(
            f"Warning: Archiving media item {media_item_id} is not currently supported via the API."
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
    ) -> Optional[str]:  # Return Optional[str]
        """
        Upload a video to Google Photos

        Args:
            local_path: Path to the local video file
            desired_filename: Optional new filename for the video (without extension)
                              Due to Google Photos API limitations, this will be used as description instead.
            target_location_hint: Optional album ID to upload to

        Returns:
            The media item ID of the uploaded video, or None if failed
        """
        if not self.service:
            print("Google Photos service not available. Cannot upload.")
            return None
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
        print(f"Starting Google Photos upload process for: {local_path.name}")
        upload_token = self._upload_bytes(local_path)
        if not upload_token:
            print(f"Failed to get upload token for {local_path.name}. Aborting upload.")
            # Don't raise here, allow graceful failure
            return None

        # Create the media item
        media_item_id = self._create_media_item(upload_token, description, album_id)
        if not media_item_id:
            print(
                f"Failed to create media item for {local_path.name}. Aborting upload."
            )
            # Don't raise here
            return None

        # Archive the media item if configured
        if self.config.archive_after_upload:
            print(f"Archiving configured for {media_item_id}...")
            archived = self._archive_media_item(media_item_id)
            if not archived:
                print(
                    f"Failed to archive media item {media_item_id}. It remains in the library."
                )
                # Continue anyway, as upload was successful
            else:
                print(f"Media item {media_item_id} archived successfully.")

        return media_item_id
