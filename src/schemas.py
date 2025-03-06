from typing import List

from pydantic import BaseModel, ValidationInfo, field_validator


class DownloaderParams(BaseModel):
    url: str | None = None
    urls: List[str] | None = None
    filename: str | None = None

    @classmethod
    def _has_urls_list(cls, info: ValidationInfo) -> bool:
        return "urls" in info.data and info.data["urls"] is not None

    @classmethod
    def _has_single_url(cls, info: ValidationInfo) -> bool:
        return "url" in info.data and info.data["url"] is not None

    @classmethod
    def _no_urls_provided(cls, v: str | List[str] | None, info: ValidationInfo) -> bool:
        return (
            v is None and not cls._has_single_url(info) and not cls._has_urls_list(info)
        )

    @field_validator("urls", "url")
    def validate_urls_provided(cls, v: str | List[str] | None, info: ValidationInfo):
        if cls._has_urls_list(info) or cls._has_single_url(info):
            return v

        if cls._no_urls_provided(v, info):
            raise ValueError("At least one URL must be provided (use url or urls)")

        return v

    @field_validator("filename")
    def validate_filename(cls, v: str | None, info: ValidationInfo):
        if v and cls._has_urls_list(info):
            raise ValueError(
                "Custom filename can only be used with single URL download"
            )
        return v

    def get_urls(self) -> List[str]:
        if self.url:
            return [self.url]
        return self.urls or []
