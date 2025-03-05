from pydantic import BaseModel


class DownloaderParams(BaseModel):
    url: str
    filename: str | None = None
