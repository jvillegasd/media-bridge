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
