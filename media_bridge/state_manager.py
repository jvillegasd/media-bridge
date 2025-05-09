import datetime
import logging
import sqlite3
from pathlib import Path
from typing import Any, Dict, List, Optional

logger = logging.getLogger("media_bridge.state_manager")

# Define constants for status values
STATUS_PENDING_DOWNLOAD = "PENDING_DOWNLOAD"
STATUS_DOWNLOADED = "DOWNLOADED"
STATUS_UPLOAD_PENDING = "UPLOAD_PENDING"  # Generic, service-specific will be columns
STATUS_COMPLETED = "COMPLETED"  # All enabled services uploaded
STATUS_FAILED_DOWNLOAD = "FAILED_DOWNLOAD"
STATUS_FAILED_UPLOAD = "FAILED_UPLOAD"


class StateManager:
    def __init__(self, db_path: Path):
        self.db_path = db_path
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self._conn = None
        self._connect()
        self._create_tables()

    def _connect(self):
        """Establish a connection to the SQLite database."""
        try:
            self._conn = sqlite3.connect(
                self.db_path,
                detect_types=sqlite3.PARSE_DECLTYPES | sqlite3.PARSE_COLNAMES,
            )
            self._conn.row_factory = sqlite3.Row  # Access columns by name
            logger.info(f"Connected to state database: {self.db_path}")
        except sqlite3.Error as e:
            logger.error(
                f"Error connecting to database {self.db_path}: {e}", exc_info=True
            )
            self._conn = None  # Ensure conn is None if connection failed

    def _create_tables(self):
        """Create necessary tables if they don't exist."""
        if not self._conn:
            logger.warning("Cannot create tables, no database connection.")
            return
        try:
            with self._conn:
                self._conn.execute("""
                    CREATE TABLE IF NOT EXISTS media_items (
                        video_url TEXT PRIMARY KEY,
                        title TEXT,
                        download_timestamp TIMESTAMP,
                        local_path TEXT,
                        status TEXT DEFAULT 'PENDING_DOWNLOAD',
                        last_attempt_timestamp TIMESTAMP,
                        yt_dlp_id TEXT, -- yt-dlp's internal ID if available
                        error_message TEXT -- Store last error for this item
                    )
                """)
                self._conn.execute("""
                    CREATE TABLE IF NOT EXISTS upload_status (
                        video_url TEXT,
                        uploader_id TEXT, -- e.g., 'google_drive', 'google_photos'
                        uploaded_id TEXT, -- Cloud service's ID for the item
                        upload_timestamp TIMESTAMP,
                        status TEXT, -- e.g., 'SUCCESS', 'FAILED', 'PENDING'
                        PRIMARY KEY (video_url, uploader_id),
                        FOREIGN KEY (video_url) REFERENCES media_items (video_url) ON DELETE CASCADE
                    )
                """)
                logger.info("Database tables ensured.")
        except sqlite3.Error as e:
            logger.error(f"Error creating tables: {e}", exc_info=True)

    def close(self):
        if self._conn:
            self._conn.close()
            self._conn = None
            logger.info("State database connection closed.")

    def add_or_update_media_item(
        self,
        video_url: str,
        title: Optional[str] = None,
        local_path: Optional[Path] = None,
        status: str = STATUS_PENDING_DOWNLOAD,
        yt_dlp_id: Optional[str] = None,
        error_message: Optional[str] = None,
    ):
        if not self._conn:
            logger.warning("No DB connection, cannot update media item.")
            return
        now = datetime.datetime.now()
        try:
            with self._conn:
                self._conn.execute(
                    """
                    INSERT INTO media_items (video_url, title, local_path, status, yt_dlp_id, download_timestamp, last_attempt_timestamp, error_message)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT(video_url) DO UPDATE SET
                        title = COALESCE(excluded.title, title),
                        local_path = COALESCE(excluded.local_path, local_path),
                        status = excluded.status,
                        yt_dlp_id = COALESCE(excluded.yt_dlp_id, yt_dlp_id),
                        download_timestamp = CASE excluded.status WHEN 'DOWNLOADED' THEN COALESCE(excluded.download_timestamp, download_timestamp) ELSE download_timestamp END,
                        last_attempt_timestamp = excluded.last_attempt_timestamp,
                        error_message = excluded.error_message
                """,
                    (
                        video_url,
                        title,
                        str(local_path) if local_path else None,
                        status,
                        yt_dlp_id,
                        now if status == STATUS_DOWNLOADED else None,
                        now,
                        error_message,
                    ),
                )
            logger.debug(
                f"Media item {video_url} added/updated with status: {status}, local_path: {local_path}"
            )
        except sqlite3.Error as e:
            logger.error(
                f"Error adding/updating media item {video_url}: {e}", exc_info=True
            )

    def update_upload_status(
        self,
        video_url: str,
        uploader_id: str,
        status: str,
        uploaded_id: Optional[str] = None,
    ):
        if not self._conn:
            logger.warning("No DB connection, cannot update upload status.")
            return
        now = datetime.datetime.now()
        upload_ts = now if status == "SUCCESS" else None
        try:
            with self._conn:
                self._conn.execute(
                    """
                    INSERT INTO upload_status (video_url, uploader_id, status, uploaded_id, upload_timestamp)
                    VALUES (?, ?, ?, ?, ?)
                    ON CONFLICT(video_url, uploader_id) DO UPDATE SET
                        status = excluded.status,
                        uploaded_id = excluded.uploaded_id,
                        upload_timestamp = excluded.upload_timestamp
                """,
                    (video_url, uploader_id, status, uploaded_id, upload_ts),
                )
                logger.debug(
                    f"Upload status for {video_url} on {uploader_id} updated to {status}"
                )
        except sqlite3.Error as e:
            logger.error(
                f"Error updating upload status for {video_url} on {uploader_id}: {e}",
                exc_info=True,
            )

    def get_media_item_details(self, video_url: str) -> Optional[Dict[str, Any]]:
        if not self._conn:
            logger.warning("No DB connection, cannot get media item details.")
            return None
        try:
            cur = self._conn.execute(
                "SELECT * FROM media_items WHERE video_url = ?", (video_url,)
            )
            row = cur.fetchone()
            if row:
                details = dict(row)
                cur_uploads = self._conn.execute(
                    "SELECT uploader_id, status, uploaded_id FROM upload_status WHERE video_url = ?",
                    (video_url,),
                )
                details["uploads"] = {
                    r["uploader_id"]: {"status": r["status"], "id": r["uploaded_id"]}
                    for r in cur_uploads.fetchall()
                }
                return details
            return None
        except sqlite3.Error as e:
            logger.error(f"Error fetching media item {video_url}: {e}", exc_info=True)
            return None

    def is_video_processed_for_uploaders(
        self, video_url: str, uploader_ids: List[str]
    ) -> bool:
        """Checks if a video has been successfully uploaded by ALL specified uploader_ids."""
        if not self._conn or not uploader_ids:
            return False  # If no uploaders, it's not processed for them.
        details = self.get_media_item_details(video_url)
        if not details or not details.get("uploads"):
            return False

        for uploader_id in uploader_ids:
            if details["uploads"].get(uploader_id, {}).get("status") != "SUCCESS":
                return False
        return True

    def get_pending_uploads(
        self, video_url: str, uploader_ids: List[str]
    ) -> Dict[str, Optional[str]]:
        """Returns a dict of uploader_id to local_path for uploads that are pending or failed for the given video."""
        if not self._conn:
            return {}
        details = self.get_media_item_details(video_url)
        if not details or details.get("status") != STATUS_DOWNLOADED:
            return {}

        pending: Dict[str, Optional[str]] = {}
        local_path = details.get("local_path")

        for uploader_id in uploader_ids:
            upload_info = details.get("uploads", {}).get(uploader_id)
            if not upload_info or upload_info.get("status") != "SUCCESS":
                pending[uploader_id] = local_path  # type: ignore[assignment]
        return pending

    def get_local_path(self, video_url: str) -> Optional[Path]:
        if not self._conn:
            return None
        details = self.get_media_item_details(video_url)
        if details and details.get("local_path"):
            return Path(details["local_path"])
        return None

    def update_item_status_if_all_uploads_done(
        self, video_url: str, enabled_uploader_ids: List[str]
    ):
        if not self._conn:
            logger.warning("No DB connection, cannot update overall item status.")
            return
        if not enabled_uploader_ids:
            # If no uploaders are enabled, consider download as completed.
            self.add_or_update_media_item(video_url, status=STATUS_COMPLETED)
            return

        if self.is_video_processed_for_uploaders(video_url, enabled_uploader_ids):
            self.add_or_update_media_item(video_url, status=STATUS_COMPLETED)
            logger.info(
                f"All enabled uploads for {video_url} are complete. Marked as COMPLETED."
            )
        else:
            details = self.get_media_item_details(video_url)
            current_status_for_log = details.get("status") if details else "N/A"
            has_pending_or_failed = False
            if details and details.get("status") not in [
                STATUS_FAILED_DOWNLOAD,
                STATUS_FAILED_UPLOAD,
            ]:
                current_main_status = details.get("status")
                if current_main_status == STATUS_DOWNLOADED:
                    for u_id in enabled_uploader_ids:
                        u_stat = details.get("uploads", {}).get(u_id, {}).get("status")
                        if u_stat in ["PENDING", "FAILED"]:
                            has_pending_or_failed = True
                            break
                    if has_pending_or_failed:
                        self.add_or_update_media_item(
                            video_url, status=STATUS_UPLOAD_PENDING
                        )
                        logger.info(
                            f"{video_url} has pending/failed uploads. Status set to UPLOAD_PENDING."
                        )
                        current_status_for_log = (
                            STATUS_UPLOAD_PENDING  # Update for final log message
                        )
                    else:
                        # If downloaded and no pending/failed, but not all success yet, it remains DOWNLOADED
                        logger.debug(
                            f"{video_url} is downloaded, some uploads may not be SUCCESS yet but none are PENDING/FAILED."
                        )
            logger.debug(
                f"Checked all uploads for {video_url}, not all completed. Final status for item: {current_status_for_log}"
            )
