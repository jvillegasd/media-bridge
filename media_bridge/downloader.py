import yt_dlp

from media_bridge.schemas import DownloaderParams


class Downloader:
    def __init__(self, params: DownloaderParams):
        self.params = params
        output_template = "%(title)s.%(ext)s"

        if self.params.filename:
            output_template = f"{self.params.filename}.%(ext)s"

        if self.params.output_path:
            output_template = str(self.params.output_path / output_template)

        self._downloader_options = {
            "format": "best",
            "outtmpl": output_template,
            "sleep_interval": 1,
            "max_sleep_interval": 5,
        }

    def download_videos(self):
        with yt_dlp.YoutubeDL(self._downloader_options) as ydl:
            ydl.download(self.params.get_urls())
