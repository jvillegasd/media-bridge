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
    """Test MediaStatus enum functionality."""
    # Test valid status values
    assert MediaStatus.PENDING_DOWNLOAD.value == "PENDING_DOWNLOAD"
    assert MediaStatus.DOWNLOADED.value == "DOWNLOADED"
    assert MediaStatus.UPLOAD_PENDING.value == "UPLOAD_PENDING"
    assert MediaStatus.COMPLETED.value == "COMPLETED"
    assert MediaStatus.FAILED_DOWNLOAD.value == "FAILED_DOWNLOAD"
    assert MediaStatus.FAILED_UPLOAD.value == "FAILED_UPLOAD"

    # Test from_str method
    assert MediaStatus.from_str("PENDING_DOWNLOAD") == MediaStatus.PENDING_DOWNLOAD
    assert MediaStatus.from_str("DOWNLOADED") == MediaStatus.DOWNLOADED
    assert MediaStatus.from_str("INVALID") is None
    assert MediaStatus.from_str(None) is None

    # Test enum comparison
    assert MediaStatus.PENDING_DOWNLOAD != MediaStatus.DOWNLOADED
    assert MediaStatus.PENDING_DOWNLOAD == MediaStatus.PENDING_DOWNLOAD


def test_upload_status_enum():
    """Test UploadStatus enum functionality."""
    # Test valid status values
    assert UploadStatus.PENDING.value == "PENDING"
    assert UploadStatus.SUCCESS.value == "SUCCESS"
    assert UploadStatus.FAILED.value == "FAILED"

    # Test from_str method
    assert UploadStatus.from_str("PENDING") == UploadStatus.PENDING
    assert UploadStatus.from_str("SUCCESS") == UploadStatus.SUCCESS
    assert UploadStatus.from_str("INVALID") is None
    assert UploadStatus.from_str(None) is None

    # Test enum comparison
    assert UploadStatus.PENDING != UploadStatus.SUCCESS
    assert UploadStatus.PENDING == UploadStatus.PENDING


def test_state_manager_with_enums(state_manager):
    """Test StateManager with enum status values."""
    # Test adding a media item with enum status
    video_url = "https://example.com/video1"
    state_manager.add_or_update_media_item(
        video_url=video_url, status=MediaStatus.PENDING_DOWNLOAD
    )

    # Verify the status was stored correctly
    details = state_manager.get_media_item_details(video_url)
    assert details is not None
    assert details["status"] == MediaStatus.PENDING_DOWNLOAD

    # Test updating status
    state_manager.add_or_update_media_item(
        video_url=video_url, status=MediaStatus.DOWNLOADED
    )
    details = state_manager.get_media_item_details(video_url)
    assert details["status"] == MediaStatus.DOWNLOADED

    # Test upload status
    uploader_id = "test_uploader"
    state_manager.update_upload_status(
        video_url=video_url, uploader_id=uploader_id, status=UploadStatus.PENDING
    )

    details = state_manager.get_media_item_details(video_url)
    assert details["uploads"][uploader_id]["status"] == UploadStatus.PENDING

    # Test successful upload
    state_manager.update_upload_status(
        video_url=video_url,
        uploader_id=uploader_id,
        status=UploadStatus.SUCCESS,
        uploaded_id="test_id",
    )

    details = state_manager.get_media_item_details(video_url)
    assert details["uploads"][uploader_id]["status"] == UploadStatus.SUCCESS
    assert details["uploads"][uploader_id]["id"] == "test_id"


def test_state_manager_status_transitions(state_manager):
    """Test status transitions in StateManager."""
    video_url = "https://example.com/video2"
    uploader_id = "test_uploader"

    # Start with pending download
    state_manager.add_or_update_media_item(
        video_url=video_url, status=MediaStatus.PENDING_DOWNLOAD
    )

    # Simulate download completion
    state_manager.add_or_update_media_item(
        video_url=video_url, status=MediaStatus.DOWNLOADED
    )

    # Start upload
    state_manager.update_upload_status(
        video_url=video_url, uploader_id=uploader_id, status=UploadStatus.PENDING
    )

    # Verify upload pending status
    state_manager.update_item_status_if_all_uploads_done(video_url, [uploader_id])
    details = state_manager.get_media_item_details(video_url)
    assert details["status"] == MediaStatus.UPLOAD_PENDING

    # Complete upload
    state_manager.update_upload_status(
        video_url=video_url,
        uploader_id=uploader_id,
        status=UploadStatus.SUCCESS,
        uploaded_id="test_id",
    )

    # Verify completed status
    state_manager.update_item_status_if_all_uploads_done(video_url, [uploader_id])
    details = state_manager.get_media_item_details(video_url)
    assert details["status"] == MediaStatus.COMPLETED


def test_state_manager_error_handling(state_manager):
    """Test error handling in StateManager."""
    video_url = "https://example.com/video3"
    uploader_id = "test_uploader"

    # Test with invalid status string in database
    with state_manager._conn:
        state_manager._conn.execute(
            """
            INSERT INTO media_items (video_url, status)
            VALUES (?, ?)
            """,
            (video_url, "INVALID_STATUS"),
        )

    # Should handle invalid status gracefully
    details = state_manager.get_media_item_details(video_url)
    assert details is not None
    assert details["status"] is None

    # Test with invalid upload status
    with state_manager._conn:
        state_manager._conn.execute(
            """
            INSERT INTO upload_status (video_url, uploader_id, status)
            VALUES (?, ?, ?)
            """,
            (video_url, uploader_id, "INVALID_UPLOAD_STATUS"),
        )

    details = state_manager.get_media_item_details(video_url)
    assert details["uploads"][uploader_id]["status"] is None


def test_state_manager_edge_cases(state_manager):
    """Test edge cases in StateManager."""
    video_url = "https://example.com/video4"

    # Test with empty uploader list
    state_manager.add_or_update_media_item(
        video_url=video_url, status=MediaStatus.DOWNLOADED
    )
    state_manager.update_item_status_if_all_uploads_done(video_url, [])
    details = state_manager.get_media_item_details(video_url)
    assert details["status"] == MediaStatus.COMPLETED

    # Test with multiple uploaders
    uploader_ids = ["uploader1", "uploader2", "uploader3"]
    for u_id in uploader_ids:
        state_manager.update_upload_status(
            video_url=video_url, uploader_id=u_id, status=UploadStatus.PENDING
        )

    # Verify all uploaders are tracked
    details = state_manager.get_media_item_details(video_url)
    assert len(details["uploads"]) == len(uploader_ids)

    # Test partial success
    state_manager.update_upload_status(
        video_url=video_url, uploader_id=uploader_ids[0], status=UploadStatus.SUCCESS
    )
    state_manager.update_item_status_if_all_uploads_done(video_url, uploader_ids)
    details = state_manager.get_media_item_details(video_url)
    assert details["status"] == MediaStatus.UPLOAD_PENDING


def test_state_manager_status_validation(state_manager):
    """Test status validation in StateManager."""
    video_url = "https://example.com/video5"
    uploader_id = "test_uploader"

    # Test invalid status transitions
    state_manager.add_or_update_media_item(
        video_url=video_url, status=MediaStatus.FAILED_DOWNLOAD
    )
    state_manager.update_item_status_if_all_uploads_done(video_url, [uploader_id])
    details = state_manager.get_media_item_details(video_url)
    assert details["status"] == MediaStatus.FAILED_DOWNLOAD  # Should not change

    # Test failed upload handling
    state_manager.add_or_update_media_item(
        video_url=video_url, status=MediaStatus.DOWNLOADED
    )
    state_manager.update_upload_status(
        video_url=video_url, uploader_id=uploader_id, status=UploadStatus.FAILED
    )
    state_manager.update_item_status_if_all_uploads_done(video_url, [uploader_id])
    details = state_manager.get_media_item_details(video_url)
    assert (
        details["status"] == MediaStatus.UPLOAD_PENDING
    )  # Should be pending for retry
