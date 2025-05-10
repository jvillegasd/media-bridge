from unittest.mock import MagicMock, patch

import pytest
from googleapiclient.errors import HttpError

from media_bridge.error_handler import (
    UploadConnectionError,
    UploadFormatError,
    UploadPermissionError,
    UploadQuotaError,
    UploadRateLimitError,
    UploadSizeError,
    UploadTimeoutError,
)
from media_bridge.integrations.google_drive import MAX_FILE_SIZE, GoogleDriveUploader


@pytest.fixture
def mock_service():
    """Create a mock Google Drive service."""
    with patch("media_bridge.integrations.google_drive.build") as mock_build:
        service = MagicMock()
        mock_build.return_value = service
        yield service


@pytest.fixture
def uploader(mock_service):
    """Create a GoogleDriveUploader instance with mocked service."""
    with patch("media_bridge.integrations.google_drive.InstalledAppFlow") as mock_flow:
        mock_flow.return_value.run_local_server.return_value = MagicMock()
        uploader = GoogleDriveUploader()
        uploader.service = mock_service
        return uploader


def test_validate_file_supported_format(uploader, tmp_path):
    """Test file validation with supported format."""
    # Create a test file with supported format
    test_file = tmp_path / "test.mp4"
    test_file.write_bytes(b"test content")

    # Should not raise any error
    uploader._validate_file(test_file)


def test_validate_file_unsupported_format(uploader, tmp_path):
    """Test file validation with unsupported format."""
    # Create a test file with unsupported format
    test_file = tmp_path / "test.xyz"
    test_file.write_bytes(b"test content")

    with pytest.raises(UploadFormatError) as exc_info:
        uploader._validate_file(test_file)

    assert "Unsupported file format" in str(exc_info.value)
    assert ".xyz" in str(exc_info.value)


def test_validate_file_size_limit(uploader, tmp_path):
    """Test file validation with size limit."""
    # Create a test file exceeding size limit
    test_file = tmp_path / "test.mp4"
    test_file.write_bytes(b"x" * (MAX_FILE_SIZE + 1))

    with pytest.raises(UploadSizeError) as exc_info:
        uploader._validate_file(test_file)

    assert "exceeds maximum allowed size" in str(exc_info.value)


def test_check_quota_sufficient(uploader, mock_service):
    """Test quota check with sufficient quota."""
    mock_service.about().get().execute.return_value = {
        "storageQuota": {"limit": "1000000000", "usage": "500000000"}
    }

    # Should not raise any error
    uploader._check_quota()


def test_check_quota_exceeded(uploader, mock_service):
    """Test quota check with exceeded quota."""
    mock_service.about().get().execute.return_value = {
        "storageQuota": {"limit": "1000000000", "usage": "1000000000"}
    }

    with pytest.raises(UploadQuotaError) as exc_info:
        uploader._check_quota()

    assert "Storage quota exceeded" in str(exc_info.value)


def test_check_quota_permission_denied(uploader, mock_service):
    """Test quota check with permission denied."""
    mock_service.about().get().execute.side_effect = HttpError(
        resp=MagicMock(status=403), content=b"Permission denied"
    )

    with pytest.raises(UploadQuotaError) as exc_info:
        uploader._check_quota()

    assert "Permission denied" in str(exc_info.value)


def test_check_permissions_success(uploader, mock_service):
    """Test permission check with success."""
    mock_service.files().list().execute.return_value = {"files": []}

    # Should not raise any error
    uploader._check_permissions()


def test_check_permissions_denied(uploader, mock_service):
    """Test permission check with permission denied."""
    mock_service.files().list().execute.side_effect = HttpError(
        resp=MagicMock(status=403), content=b"Permission denied"
    )

    with pytest.raises(UploadPermissionError) as exc_info:
        uploader._check_permissions()

    assert "Permission denied" in str(exc_info.value)


def test_do_upload_success(uploader, mock_service, tmp_path):
    """Test successful upload."""
    # Create a test file
    test_file = tmp_path / "test.mp4"
    test_file.write_bytes(b"test content")

    mock_service.files().create().execute.return_value = {"id": "test_file_id"}

    file_id = uploader._do_upload(test_file, "test.mp4")
    assert file_id == "test_file_id"


def test_do_upload_permission_denied(uploader, mock_service, tmp_path):
    """Test upload with permission denied."""
    test_file = tmp_path / "test.mp4"
    test_file.write_bytes(b"test content")

    mock_service.files().create().execute.side_effect = HttpError(
        resp=MagicMock(status=403), content=b"Permission denied"
    )

    with pytest.raises(UploadPermissionError) as exc_info:
        uploader._do_upload(test_file, "test.mp4")

    assert "Permission denied" in str(exc_info.value)


def test_do_upload_rate_limit(uploader, mock_service, tmp_path):
    """Test upload with rate limit exceeded."""
    test_file = tmp_path / "test.mp4"
    test_file.write_bytes(b"test content")

    mock_service.files().create().execute.side_effect = HttpError(
        resp=MagicMock(status=429), content=b"Rate limit exceeded"
    )

    with pytest.raises(UploadRateLimitError) as exc_info:
        uploader._do_upload(test_file, "test.mp4")

    assert "Rate limit exceeded" in str(exc_info.value)


def test_do_upload_timeout(uploader, mock_service, tmp_path):
    """Test upload with timeout."""
    test_file = tmp_path / "test.mp4"
    test_file.write_bytes(b"test content")

    mock_service.files().create().execute.side_effect = HttpError(
        resp=MagicMock(status=408), content=b"Request timeout"
    )

    with pytest.raises(UploadTimeoutError) as exc_info:
        uploader._do_upload(test_file, "test.mp4")

    assert "timed out" in str(exc_info.value)


def test_do_upload_service_unavailable(uploader, mock_service, tmp_path):
    """Test upload with service unavailable."""
    test_file = tmp_path / "test.mp4"
    test_file.write_bytes(b"test content")

    mock_service.files().create().execute.side_effect = HttpError(
        resp=MagicMock(status=503), content=b"Service unavailable"
    )

    with pytest.raises(UploadConnectionError) as exc_info:
        uploader._do_upload(test_file, "test.mp4")

    assert "service unavailable" in str(exc_info.value).lower()


def test_upload_video_retry_success(uploader, mock_service, tmp_path):
    """Test upload with retry success."""
    test_file = tmp_path / "test.mp4"
    test_file.write_bytes(b"test content")

    # First attempt fails with timeout, second succeeds
    mock_service.files().create().execute.side_effect = [
        HttpError(resp=MagicMock(status=408), content=b"Timeout"),
        {"id": "test_file_id"},
    ]

    file_id = uploader.upload_video(test_file, "test.mp4")
    assert file_id == "test_file_id"
    assert mock_service.files().create().execute.call_count == 2


def test_upload_video_non_retryable_error(uploader, mock_service, tmp_path):
    """Test upload with non-retryable error."""
    test_file = tmp_path / "test.mp4"
    test_file.write_bytes(b"test content")

    mock_service.files().create().execute.side_effect = HttpError(
        resp=MagicMock(status=403), content=b"Permission denied"
    )

    with pytest.raises(UploadPermissionError):
        uploader.upload_video(test_file, "test.mp4")

    # Should not retry for non-retryable errors
    assert mock_service.files().create().execute.call_count == 1
