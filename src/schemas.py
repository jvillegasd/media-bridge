from typing import List
from pydantic import BaseModel


class DownloaderParams(BaseModel):
    url: str | None = None
    urls: List[str] | None = None
    filename: str | None = None

    def get_urls(self) -> List[str]:
        if self.url:
            return [self.url]
        return self.urls or []
