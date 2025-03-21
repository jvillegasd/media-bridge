import yt_dlp

from media_bridge.schemas import DownloaderParams


class Downloader:
    def __init__(self, params: DownloaderParams):
        self.params = params
        self._downloaded_files = []
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
            "progress_hooks": [self._log_hook],
        }

    def download_videos(self) -> list[str]:
        self._downloaded_files = []

        options = self._downloader_options.copy()

        with yt_dlp.YoutubeDL(options) as ydl:
            ydl.download(self.params.get_urls())

        return self._downloaded_files

    def _log_hook(self, download: dict):
        if download["status"] == "finished":
            self._downloaded_files.append(download["filename"])
