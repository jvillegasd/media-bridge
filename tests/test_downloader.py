from unittest.mock import patch

import pytest
import yt_dlp

from src.downloader import Downloader
from src.schemas import DownloaderParams


def test_downloader_initialization(valid_params):
    downloader = Downloader(valid_params)
    assert downloader.params == valid_params
    assert downloader._downloader_options["outtmpl"] == "test_video.%(ext)s"


def test_downloader_default_options():
    params = DownloaderParams(urls=["https://youtube.com/watch?v=123"])
    downloader = Downloader(params)
    assert downloader._downloader_options["outtmpl"] == "%(title)s.%(ext)s"
    assert downloader._downloader_options["format"] == "best"


@patch("yt_dlp.YoutubeDL")
def test_download_videos_alt(mock_ytdl, valid_params):
    downloader = Downloader(valid_params)
    downloader.download_videos()

    mock_ytdl.assert_called_once_with(downloader._downloader_options)
    mock_instance = mock_ytdl.return_value.__enter__.return_value
    mock_instance.download.assert_called_once_with(valid_params.get_urls())


@patch("yt_dlp.YoutubeDL")
def test_download_with_invalid_url(mock_ytdl):
    # Setup mock to raise an error
    mock_instance = mock_ytdl.return_value.__enter__.return_value
    mock_instance.download.side_effect = yt_dlp.utils.DownloadError("Invalid URL")

    params = DownloaderParams(urls=["not_a_url"])
    downloader = Downloader(params)

    with pytest.raises(yt_dlp.utils.DownloadError):
        downloader.download_videos()

    mock_ytdl.assert_called_once_with(downloader._downloader_options)
    mock_instance.download.assert_called_once_with(["not_a_url"])
