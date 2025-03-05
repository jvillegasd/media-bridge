from typing import List
from pydantic import BaseModel, ValidationInfo, field_validator


class DownloaderParams(BaseModel):
    url: str | None = None
    urls: List[str] | None = None
    filename: str | None = None

    @field_validator("urls", "url")
    def validate_urls_provided(cls, v: str | List[str] | None, values: ValidationInfo):
        # Skip if we're validating url and urls is already set
        if "urls" in values and values["urls"] and v is None:
            return v
        # Skip if we're validating urls and url is already set
        if "url" in values and values["url"] and v is None:
            return v
        # Ensure at least one URL is provided
        if (
            v is None
            and ("url" not in values or values["url"] is None)
            and ("urls" not in values or values["urls"] is None)
        ):
            raise ValueError("At least one URL must be provided (use url or urls)")
        return v

    @field_validator("filename")
    def validate_filename(cls, v: str | None, values: ValidationInfo):
        if v and values.get("urls"):
            raise ValueError(
                "Custom filename can only be used with single URL download"
            )
        return v

    def get_urls(self) -> List[str]:
        if self.url:
            return [self.url]
        return self.urls or []
