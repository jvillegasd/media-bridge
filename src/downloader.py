class Downloader:
    def __init__(self):
        pass

    def download_video(self, url, filename=None):
        import yt_dlp

        output_template = filename if filename else "%(title)s"
        ydl_opts = {
            "format": "best",
            "outtmpl": f"{output_template}.%(ext)s",
            "sleep_interval": 1,
            "max_sleep_interval": 5,
        }

        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            ydl.download([url])
