import pytest
from src.downloader import Downloader
from src.schemas import DownloaderParams

def test_downloader_initialization(valid_params):
    downloader = Downloader(valid_params)
    assert downloader.params == valid_params
    assert downloader._downloader_options['outtmpl'] == "test_video.%(ext)s"

def test_downloader_default_options():
    params = DownloaderParams(urls=["https://youtube.com/watch?v=123"])
    downloader = Downloader(params)
    assert downloader._downloader_options['outtmpl'] == "%(title)s.%(ext)s"
    assert downloader._downloader_options['format'] == "best"

def test_download_videos(valid_params, mock_yt_dlp):
    downloader = Downloader(valid_params)
    downloader.download_videos()
    
    mock_yt_dlp.assert_called_once_with(downloader._downloader_options)
    mock_instance = mock_yt_dlp.return_value.__enter__.return_value
    mock_instance.download.assert_called_once_with(valid_params.get_urls())

def test_download_with_invalid_url():
    params = DownloaderParams(urls=["not_a_url"])
    downloader = Downloader(params)
    
    with pytest.raises(Exception):
        downloader.download_videos()