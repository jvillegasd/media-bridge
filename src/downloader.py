import yt_dlp

from src.schemas import DownloaderParams


class Downloader:
    def __init__(self, params: DownloaderParams):
        self.params = params
        self._downloader_options = {
            "format": "best",
            "outtmpl": "%(title)s.%(ext)s",
            "sleep_interval": 1,
            "max_sleep_interval": 5,
        }

        if self.params.filename:
            self._downloader_options["outtmpl"] = f"{self.params.filename}.%(ext)s"

    def download_videos(self):
        with yt_dlp.YoutubeDL(self._downloader_options) as ydl:
            ydl.download(self.params.get_urls())
