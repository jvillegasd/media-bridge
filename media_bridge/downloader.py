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
        downloaded_files = []

        def _log_hook(d):
            if d["status"] == "finished":
                downloaded_files.append(d["filename"])

        options = self._downloader_options.copy()
        options["progress_hooks"] = [_log_hook]

        with yt_dlp.YoutubeDL(options) as ydl:
            ydl.download(self.params.get_urls())

        return downloaded_files
