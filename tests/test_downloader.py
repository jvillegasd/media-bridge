import unittest
from src.downloader import Downloader

class TestDownloader(unittest.TestCase):

    def setUp(self):
        self.downloader = Downloader()

    def test_download_video(self):
        url = "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
        result = self.downloader.download_video(url)
        self.assertTrue(result)  # Assuming download_video returns True on success

    def test_invalid_url(self):
        url = "invalid_url"
        with self.assertRaises(ValueError):
            self.downloader.download_video(url)

if __name__ == '__main__':
    unittest.main()