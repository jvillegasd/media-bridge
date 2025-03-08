from unittest.mock import patch

import pytest

from media_bridge.schemas import DownloaderParams


@pytest.fixture
def valid_params():
    return DownloaderParams(
        url="https://www.youtube.com/watch?v=dQw4w9WgXcQ", filename="test_video"
    )


@pytest.fixture
def mock_yt_dlp():
    with patch("yt_dlp.YoutubeDL") as mock:
        yield mock
