from pathlib import Path

import pytest

from media_bridge.state_manager import StateManager
from media_bridge.status import MediaStatus, UploadStatus


@pytest.fixture
def state_manager(tmp_path):
    db_path = tmp_path / "test_state.db"
    manager = StateManager(db_path)
    yield manager
    manager.close()


def test_media_status_enum():
    """Test MediaStatus enum values and conversion."""
    assert MediaStatus.PENDING_DOWNLOAD.value == "PENDING_DOWNLOAD"
    assert MediaStatus.DOWNLOADING.value == "DOWNLOADING"
    assert MediaStatus.DOWNLOADED.value == "DOWNLOADED"
    assert MediaStatus.FAILED_DOWNLOAD.value == "FAILED_DOWNLOAD"
    assert MediaStatus.PENDING_UPLOAD.value == "PENDING_UPLOAD"
    assert MediaStatus.UPLOADING.value == "UPLOADING"
    assert MediaStatus.FAILED_UPLOAD.value == "FAILED_UPLOAD"
    assert MediaStatus.COMPLETED.value == "COMPLETED"

    # Test from_str method
    assert MediaStatus.from_str("PENDING_DOWNLOAD") == MediaStatus.PENDING_DOWNLOAD
    assert MediaStatus.from_str("DOWNLOADING") == MediaStatus.DOWNLOADING
    assert MediaStatus.from_str("DOWNLOADED") == MediaStatus.DOWNLOADED
    assert MediaStatus.from_str("FAILED_DOWNLOAD") == MediaStatus.FAILED_DOWNLOAD
    assert MediaStatus.from_str("PENDING_UPLOAD") == MediaStatus.PENDING_UPLOAD
    assert MediaStatus.from_str("UPLOADING") == MediaStatus.UPLOADING
    assert MediaStatus.from_str("FAILED_UPLOAD") == MediaStatus.FAILED_UPLOAD
    assert MediaStatus.from_str("COMPLETED") == MediaStatus.COMPLETED

    # Test invalid status
    with pytest.raises(ValueError):
        MediaStatus.from_str("INVALID_STATUS")


def test_upload_status_enum():
    """Test UploadStatus enum values and conversion."""
    assert UploadStatus.PENDING.value == "PENDING"
    assert UploadStatus.SUCCESS.value == "SUCCESS"
    assert UploadStatus.FAILED.value == "FAILED"

    # Test from_str method
    assert UploadStatus.from_str("PENDING") == UploadStatus.PENDING
    assert UploadStatus.from_str("SUCCESS") == UploadStatus.SUCCESS
    assert UploadStatus.from_str("FAILED") == UploadStatus.FAILED

    # Test invalid status
    with pytest.raises(ValueError):
        UploadStatus.from_str("INVALID_STATUS")


def test_state_manager_with_enums(state_manager):
    """Test StateManager with enum statuses."""
    # Test adding a media item
    video_url = "https://example.com/video1"
    state_manager.add_or_update_media_item(
        video_url=video_url,
        title="Test Video",
        status=MediaStatus.PENDING_DOWNLOAD,
        metadata={"source": "test", "quality": "720p"},
    )

    # Verify the item was added
    details = state_manager.get_media_item_details(video_url)
    assert details is not None
    assert details["video_url"] == video_url
    assert details["title"] == "Test Video"
    assert details["status"] == MediaStatus.PENDING_DOWNLOAD
    assert details["retry_count"] == 0
    assert details["metadata"] == {"source": "test", "quality": "720p"}
    assert "created_at" in details
    assert "updated_at" in details

    # Test updating status with error
    state_manager.add_or_update_media_item(
        video_url=video_url,
        status=MediaStatus.FAILED_DOWNLOAD,
        error_message="Download failed",
    )

    # Verify the update
    details = state_manager.get_media_item_details(video_url)
    assert details["status"] == MediaStatus.FAILED_DOWNLOAD
    assert details["error_message"] == "Download failed"
    assert details["retry_count"] == 1
    assert details["last_error_timestamp"] is not None

    # Test adding upload status
    state_manager.update_upload_status(
        video_url=video_url,
        uploader_id="test_uploader",
        status=UploadStatus.PENDING,
        metadata={"platform": "test", "format": "mp4"},
    )

    # Verify upload status
    details = state_manager.get_media_item_details(video_url)
    assert "test_uploader" in details["uploads"]
    upload_info = details["uploads"]["test_uploader"]
    assert upload_info["status"] == UploadStatus.PENDING
    assert upload_info["retry_count"] == 0
    assert upload_info["metadata"] == {"platform": "test", "format": "mp4"}

    # Test updating upload status with error
    state_manager.update_upload_status(
        video_url=video_url,
        uploader_id="test_uploader",
        status=UploadStatus.FAILED,
        error_message="Upload failed",
    )

    # Verify upload status update
    details = state_manager.get_media_item_details(video_url)
    upload_info = details["uploads"]["test_uploader"]
    assert upload_info["status"] == UploadStatus.FAILED
    assert upload_info["retry_count"] == 1
    assert upload_info["last_error_timestamp"] is not None


def test_state_manager_status_transitions(state_manager):
    """Test status transitions and retry counting."""
    video_url = "https://example.com/video2"

    # Initial state
    state_manager.add_or_update_media_item(
        video_url=video_url, status=MediaStatus.PENDING_DOWNLOAD
    )

    # Simulate download failure
    state_manager.add_or_update_media_item(
        video_url=video_url,
        status=MediaStatus.FAILED_DOWNLOAD,
        error_message="First failure",
    )

    # Verify retry count
    details = state_manager.get_media_item_details(video_url)
    assert details["retry_count"] == 1
    assert details["last_error_timestamp"] is not None

    # Simulate another failure
    state_manager.add_or_update_media_item(
        video_url=video_url,
        status=MediaStatus.FAILED_DOWNLOAD,
        error_message="Second failure",
    )

    # Verify retry count increased
    details = state_manager.get_media_item_details(video_url)
    assert details["retry_count"] == 2

    # Simulate successful download
    state_manager.add_or_update_media_item(
        video_url=video_url,
        status=MediaStatus.DOWNLOADED,
        local_path=Path("/tmp/test.mp4"),
    )

    # Verify retry count remains the same
    details = state_manager.get_media_item_details(video_url)
    assert details["retry_count"] == 2
    assert (
        details["last_error_timestamp"] is not None
    )  # Should keep last error timestamp


def test_get_items_by_status(state_manager):
    """Test getting items by status with retry count filtering."""
    # Add items with different statuses
    for i in range(3):
        state_manager.add_or_update_media_item(
            video_url=f"https://example.com/video{i}",
            status=MediaStatus.PENDING_DOWNLOAD,
        )

    # Add a failed item
    state_manager.add_or_update_media_item(
        video_url="https://example.com/failed",
        status=MediaStatus.FAILED_DOWNLOAD,
        error_message="Test failure",
    )

    # Test getting pending items
    pending_items = state_manager.get_items_by_status(MediaStatus.PENDING_DOWNLOAD)
    assert len(pending_items) == 3

    # Test getting failed items
    failed_items = state_manager.get_failed_items()
    assert len(failed_items) == 1
    assert failed_items[0]["video_url"] == "https://example.com/failed"

    # Test getting failed items with max retries
    failed_items = state_manager.get_failed_items(max_retries=0)
    assert len(failed_items) == 0  # Should be empty as retry_count is 1


def test_cleanup_old_items(state_manager):
    """Test cleanup of old items."""
    # Add a completed item
    state_manager.add_or_update_media_item(
        video_url="https://example.com/old", status=MediaStatus.COMPLETED
    )

    # Add a failed item
    state_manager.add_or_update_media_item(
        video_url="https://example.com/failed",
        status=MediaStatus.FAILED_DOWNLOAD,
        error_message="Test failure",
    )

    # Add a pending item
    state_manager.add_or_update_media_item(
        video_url="https://example.com/pending", status=MediaStatus.PENDING_DOWNLOAD
    )

    # Clean up items older than 1 day (should not remove anything as items are new)
    removed = state_manager.cleanup_old_items(days=1)
    assert removed == 0

    # Verify all items still exist
    assert state_manager.get_media_item_details("https://example.com/old") is not None
    assert (
        state_manager.get_media_item_details("https://example.com/failed") is not None
    )
    assert (
        state_manager.get_media_item_details("https://example.com/pending") is not None
    )
