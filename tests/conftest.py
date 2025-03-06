import pytest
from src.schemas import DownloaderParams

@pytest.fixture
def valid_params():
    return DownloaderParams(
        urls=["https://www.youtube.com/watch?v=dQw4w9WgXcQ"],
        filename="test_video"
    )

@pytest.fixture
def mock_yt_dlp(mocker):
    mock_ytdl = mocker.patch('yt_dlp.YoutubeDL')
    return mock_ytdl
