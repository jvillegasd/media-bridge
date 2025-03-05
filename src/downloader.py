class Downloader:
    def __init__(self):
        pass

    def download_video(self, url):
        import yt_dlp

        ydl_opts = {
            "format": "best",
            "outtmpl": "%(title)s.%(ext)s",
            "sleep_interval": 1,
            "max_sleep_interval": 5,
        }

        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            ydl.download([url])
