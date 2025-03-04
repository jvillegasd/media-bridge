class Downloader:
    def __init__(self):
        pass

    def download_video(self, url):
        import youtube_dl

        ydl_opts = {
            'format': 'best',
            'outtmpl': '%(title)s.%(ext)s',
        }

        with youtube_dl.YoutubeDL(ydl_opts) as ydl:
            ydl.download([url])