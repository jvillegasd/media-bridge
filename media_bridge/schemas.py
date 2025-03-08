from pathlib import Path
from typing import List

from pydantic import BaseModel, ConfigDict, model_validator


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
