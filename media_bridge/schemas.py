from pathlib import Path
from typing import List, Optional

from pydantic import BaseModel, ConfigDict, Field, FilePath, model_validator


class DownloaderParams(BaseModel):
    url: str | None = None
    urls: List[str] | None = None
    filename: str | None = None
    output_path: Path | None = None

    model_config = ConfigDict(validate_default=True)

    @model_validator(mode="after")
    def validate_urls_and_filename(self) -> "DownloaderParams":
        if not self.url and not self.urls:
            raise ValueError("At least one URL must be provided (use url or urls)")

        if self.filename and self.urls:
            raise ValueError(
                "Custom filename can only be used with single URL download"
            )

        return self

    def get_urls(self) -> List[str]:
        if self.url:
            return [self.url]
        return self.urls or []


class GoogleDriveConfig(BaseModel):
    enabled: bool = False
    credentials_file: FilePath = Field(
        ...,
        description="Path to the Google OAuth Client ID JSON file (client_secrets.json)",
    )
    token_file: Optional[Path] = Field(
        None,
        description="Path to store/load the generated OAuth token. Defaults to next to credentials_file.",
    )
    target_folder_id: Optional[str] = None
    create_folder_if_not_exists: bool = True
    rename_pattern: Optional[str] = None


class GooglePhotosConfig(BaseModel):
    enabled: bool = False
    credentials_file: FilePath = Field(
        ...,
        description="Path to the Google OAuth Client ID JSON file (client_secrets.json)",
    )
    token_file: Optional[Path] = Field(
        None,
        description="Path to store/load the generated OAuth token. Defaults to next to credentials_file.",
    )
    target_album_id: Optional[str] = None
    create_album_if_not_exists: bool = True
    rename_as_description: bool = False
    archive_after_upload: bool = False


class StorageConfig(BaseModel):
    google_drive: Optional[GoogleDriveConfig] = None
    google_photos: Optional[GooglePhotosConfig] = None


class Config(BaseModel):
    output_path: Optional[Path] = None
    storage: Optional[StorageConfig] = None
    database_path: Optional[Path] = None

    # Potentially add a validator for database_path or a default factory if needed
