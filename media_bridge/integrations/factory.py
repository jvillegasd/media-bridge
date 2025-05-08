from typing import List, Optional

from media_bridge.integrations.base import CloudStorageUploader

# Import specific uploader classes
from media_bridge.integrations.google_drive import GoogleDriveUploader
from media_bridge.integrations.google_photos import GooglePhotosUploader
from media_bridge.schemas import StorageConfig


def create_uploaders(
    storage_config: Optional[StorageConfig],
) -> List[CloudStorageUploader]:
    """
    Factory function to create and return a list of enabled cloud storage uploaders.

    Args:
        storage_config: The storage configuration object from the main config.

    Returns:
        A list of instantiated and authenticated CloudStorageUploader objects.
    """
    uploaders: List[CloudStorageUploader] = []

    if not storage_config:
        print("No storage configuration provided.")
        return uploaders

    # Google Drive
    if storage_config.google_drive and storage_config.google_drive.enabled:
        if storage_config.google_drive.credentials_file:
            print("Initializing Google Drive uploader...")
            try:
                drive_uploader = GoogleDriveUploader(config=storage_config.google_drive)
                if drive_uploader.service:  # Check if authentication was successful
                    uploaders.append(drive_uploader)
                    print("Google Drive uploader initialized successfully.")
                else:
                    print(
                        "Google Drive uploader initialized but service is not available (authentication might have failed)."
                    )
            except FileNotFoundError as e:
                print(
                    f"Error initializing Google Drive: {e}. Credentials file likely missing."
                )
            except Exception as e:
                print(f"Error initializing Google Drive uploader: {e}")
        else:
            print("Google Drive is enabled but credentials_file is not configured.")

    # Google Photos
    if storage_config.google_photos and storage_config.google_photos.enabled:
        if storage_config.google_photos.credentials_file:
            print("Initializing Google Photos uploader...")
            try:
                photos_uploader = GooglePhotosUploader(
                    config=storage_config.google_photos
                )
                if photos_uploader.service:  # Check if authentication was successful
                    uploaders.append(photos_uploader)
                    print("Google Photos uploader initialized successfully.")
                else:
                    print(
                        "Google Photos uploader initialized but service is not available (authentication might have failed)."
                    )
            except FileNotFoundError as e:
                print(
                    f"Error initializing Google Photos: {e}. Credentials file likely missing."
                )
            except Exception as e:
                print(f"Error initializing Google Photos uploader: {e}")
        else:
            print("Google Photos is enabled but credentials_file is not configured.")

    if not uploaders:
        print("No cloud storage uploaders are enabled or successfully initialized.")

    return uploaders
