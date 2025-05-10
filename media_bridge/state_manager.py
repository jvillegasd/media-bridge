import datetime
import json
import logging
import sqlite3
from pathlib import Path
from typing import Any, Dict, List, Optional

from media_bridge.status import MediaStatus, UploadStatus

logger = logging.getLogger("media_bridge.state_manager")


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
            self._conn.row_factory = sqlite3.Row
            logger.info(f"Connected to state database: {self.db_path}")
        except sqlite3.Error as e:
            logger.error(
                f"Error connecting to database {self.db_path}: {e}", exc_info=True
            )
            self._conn = None

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
                        yt_dlp_id TEXT,
                        error_message TEXT,
                        retry_count INTEGER DEFAULT 0,
                        last_error_timestamp TIMESTAMP,
                        metadata JSON,
                        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                    )
                """)
                self._conn.execute("""
                    CREATE TABLE IF NOT EXISTS upload_status (
                        video_url TEXT,
                        uploader_id TEXT,
                        uploaded_id TEXT,
                        upload_timestamp TIMESTAMP,
                        status TEXT,
                        retry_count INTEGER DEFAULT 0,
                        last_error_timestamp TIMESTAMP,
                        metadata JSON,
                        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                        PRIMARY KEY (video_url, uploader_id),
                        FOREIGN KEY (video_url) REFERENCES media_items (video_url) ON DELETE CASCADE
                    )
                """)
                # Create indexes if they don't exist
                self._conn.execute(
                    "CREATE INDEX IF NOT EXISTS idx_media_items_status ON media_items(status)"
                )
                self._conn.execute(
                    "CREATE INDEX IF NOT EXISTS idx_media_items_retry_count ON media_items(retry_count)"
                )
                self._conn.execute(
                    "CREATE INDEX IF NOT EXISTS idx_upload_status_status ON upload_status(status)"
                )
                self._conn.execute(
                    "CREATE INDEX IF NOT EXISTS idx_upload_status_retry_count ON upload_status(retry_count)"
                )
                logger.info("Database tables and indexes ensured.")
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
        status: MediaStatus = MediaStatus.PENDING_DOWNLOAD,
        yt_dlp_id: Optional[str] = None,
        error_message: Optional[str] = None,
        metadata: Optional[Dict[str, Any]] = None,
    ):
        if not self._conn:
            logger.warning("No DB connection, cannot update media item.")
            return
        now = datetime.datetime.now()
        try:
            with self._conn:
                # Get current retry count
                cur = self._conn.execute(
                    "SELECT retry_count FROM media_items WHERE video_url = ?",
                    (video_url,),
                )
                row = cur.fetchone()
                retry_count = (
                    (row["retry_count"] if row else 0) + 1
                    if error_message
                    else (row["retry_count"] if row else 0)
                )

                self._conn.execute(
                    """
                    INSERT INTO media_items (
                        video_url, title, local_path, status, yt_dlp_id,
                        download_timestamp, last_attempt_timestamp, error_message,
                        retry_count, last_error_timestamp, metadata, updated_at
                    )
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT(video_url) DO UPDATE SET
                        title = COALESCE(excluded.title, title),
                        local_path = COALESCE(excluded.local_path, local_path),
                        status = excluded.status,
                        yt_dlp_id = COALESCE(excluded.yt_dlp_id, yt_dlp_id),
                        download_timestamp = CASE excluded.status WHEN 'DOWNLOADED' THEN COALESCE(excluded.download_timestamp, download_timestamp) ELSE download_timestamp END,
                        last_attempt_timestamp = excluded.last_attempt_timestamp,
                        error_message = excluded.error_message,
                        retry_count = excluded.retry_count,
                        last_error_timestamp = CASE excluded.error_message WHEN NULL THEN last_error_timestamp ELSE excluded.last_attempt_timestamp END,
                        metadata = CASE excluded.metadata WHEN NULL THEN metadata ELSE excluded.metadata END,
                        updated_at = excluded.updated_at
                """,
                    (
                        video_url,
                        title,
                        str(local_path) if local_path else None,
                        status.value,
                        yt_dlp_id,
                        now if status == MediaStatus.DOWNLOADED else None,
                        now,
                        error_message,
                        retry_count,
                        now if error_message else None,
                        json.dumps(metadata) if metadata else None,
                        now,
                    ),
                )
            logger.debug(
                f"Media item {video_url} added/updated with status: {status.value}, retry_count: {retry_count}"
            )
        except sqlite3.Error as e:
            logger.error(
                f"Error adding/updating media item {video_url}: {e}", exc_info=True
            )

    def update_upload_status(
        self,
        video_url: str,
        uploader_id: str,
        status: UploadStatus,
        uploaded_id: Optional[str] = None,
        error_message: Optional[str] = None,
        metadata: Optional[Dict[str, Any]] = None,
    ):
        if not self._conn:
            logger.warning("No DB connection, cannot update upload status.")
            return
        now = datetime.datetime.now()
        upload_ts = now if status == UploadStatus.SUCCESS else None
        try:
            with self._conn:
                # Get current retry count
                cur = self._conn.execute(
                    "SELECT retry_count FROM upload_status WHERE video_url = ? AND uploader_id = ?",
                    (video_url, uploader_id),
                )
                row = cur.fetchone()
                retry_count = (
                    (row["retry_count"] if row else 0) + 1
                    if error_message
                    else (row["retry_count"] if row else 0)
                )

                self._conn.execute(
                    """
                    INSERT INTO upload_status (
                        video_url, uploader_id, status, uploaded_id,
                        upload_timestamp, retry_count, last_error_timestamp,
                        metadata, updated_at
                    )
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT(video_url, uploader_id) DO UPDATE SET
                        status = excluded.status,
                        uploaded_id = excluded.uploaded_id,
                        upload_timestamp = excluded.upload_timestamp,
                        retry_count = excluded.retry_count,
                        last_error_timestamp = CASE excluded.error_message WHEN NULL THEN last_error_timestamp ELSE excluded.updated_at END,
                        metadata = CASE excluded.metadata WHEN NULL THEN metadata ELSE excluded.metadata END,
                        updated_at = excluded.updated_at
                """,
                    (
                        video_url,
                        uploader_id,
                        status.value,
                        uploaded_id,
                        upload_ts,
                        retry_count,
                        now if error_message else None,
                        json.dumps(metadata) if metadata else None,
                        now,
                    ),
                )
                logger.debug(
                    f"Upload status for {video_url} on {uploader_id} updated to {status.value}, retry_count: {retry_count}"
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
                # Convert status string to enum
                details["status"] = MediaStatus.from_str(details["status"])
                # Parse metadata JSON
                if details.get("metadata"):
                    try:
                        details["metadata"] = json.loads(details["metadata"])
                    except json.JSONDecodeError:
                        details["metadata"] = {}

                cur_uploads = self._conn.execute(
                    "SELECT * FROM upload_status WHERE video_url = ?",
                    (video_url,),
                )
                details["uploads"] = {
                    r["uploader_id"]: {
                        "status": UploadStatus.from_str(r["status"]),
                        "id": r["uploaded_id"],
                        "retry_count": r["retry_count"],
                        "last_error_timestamp": r["last_error_timestamp"],
                        "metadata": json.loads(r["metadata"]) if r["metadata"] else {},
                    }
                    for r in cur_uploads.fetchall()
                }
                return details
            return None
        except sqlite3.Error as e:
            logger.error(f"Error fetching media item {video_url}: {e}", exc_info=True)
            return None

    def get_items_by_status(
        self, status: MediaStatus, max_retries: Optional[int] = None
    ) -> List[Dict[str, Any]]:
        """Get all media items with the specified status."""
        if not self._conn:
            return []
        try:
            query = "SELECT * FROM media_items WHERE status = ?"
            params = [status.value]
            if max_retries is not None:
                query += " AND retry_count <= ?"
                params.append(max_retries)
            cur = self._conn.execute(query, params)
            return [dict(row) for row in cur.fetchall()]
        except sqlite3.Error as e:
            logger.error(f"Error fetching items by status: {e}", exc_info=True)
            return []

    def get_failed_items(
        self, max_retries: Optional[int] = None
    ) -> List[Dict[str, Any]]:
        """Get all media items that have failed."""
        if not self._conn:
            return []
        try:
            query = """
                SELECT * FROM media_items
                WHERE status IN (?, ?)
            """
            params = [
                MediaStatus.FAILED_DOWNLOAD.value,
                MediaStatus.FAILED_UPLOAD.value,
            ]
            if max_retries is not None:
                query += " AND retry_count <= ?"
                params.append(max_retries)
            cur = self._conn.execute(query, params)
            return [dict(row) for row in cur.fetchall()]
        except sqlite3.Error as e:
            logger.error(f"Error fetching failed items: {e}", exc_info=True)
            return []

    def cleanup_old_items(self, days: int = 30) -> int:
        """Remove items older than specified days."""
        if not self._conn:
            return 0
        try:
            cutoff_date = datetime.datetime.now() - datetime.timedelta(days=days)
            with self._conn:
                cur = self._conn.execute(
                    """
                    DELETE FROM media_items
                    WHERE created_at < ? AND status IN (?, ?)
                    """,
                    (
                        cutoff_date,
                        MediaStatus.COMPLETED.value,
                        MediaStatus.FAILED_DOWNLOAD.value,
                    ),
                )
                return cur.rowcount
        except sqlite3.Error as e:
            logger.error(f"Error cleaning up old items: {e}", exc_info=True)
            return 0

    def is_video_processed_for_uploaders(
        self, video_url: str, uploader_ids: List[str]
    ) -> bool:
        """Checks if a video has been successfully uploaded by ALL specified uploader_ids."""
        if not self._conn or not uploader_ids:
            return False
        details = self.get_media_item_details(video_url)
        if not details or not details.get("uploads"):
            return False

        for uploader_id in uploader_ids:
            if (
                details["uploads"].get(uploader_id, {}).get("status")
                != UploadStatus.SUCCESS
            ):
                return False
        return True

    def get_pending_uploads(
        self, video_url: str, uploader_ids: List[str]
    ) -> Dict[str, Optional[str]]:
        """Returns a dict of uploader_id to local_path for uploads that are pending or failed for the given video."""
        if not self._conn:
            return {}
        details = self.get_media_item_details(video_url)
        if not details or details.get("status") != MediaStatus.DOWNLOADED:
            return {}

        pending: Dict[str, Optional[str]] = {}
        local_path = details.get("local_path")

        for uploader_id in uploader_ids:
            upload_info = details.get("uploads", {}).get(uploader_id)
            if not upload_info or upload_info.get("status") != UploadStatus.SUCCESS:
                pending[uploader_id] = local_path
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
            self.add_or_update_media_item(video_url, status=MediaStatus.COMPLETED)
            return

        if self.is_video_processed_for_uploaders(video_url, enabled_uploader_ids):
            self.add_or_update_media_item(video_url, status=MediaStatus.COMPLETED)
            logger.info(
                f"All enabled uploads for {video_url} are complete. Marked as COMPLETED."
            )
        else:
            details = self.get_media_item_details(video_url)
            current_status_for_log = details.get("status") if details else None
            has_pending_or_failed = False
            if details and details.get("status") not in [
                MediaStatus.FAILED_DOWNLOAD,
                MediaStatus.FAILED_UPLOAD,
            ]:
                current_main_status = details.get("status")
                if current_main_status == MediaStatus.DOWNLOADED:
                    for u_id in enabled_uploader_ids:
                        u_stat = details.get("uploads", {}).get(u_id, {}).get("status")
                        if u_stat in [UploadStatus.PENDING, UploadStatus.FAILED]:
                            has_pending_or_failed = True
                            break
                    if has_pending_or_failed:
                        self.add_or_update_media_item(
                            video_url, status=MediaStatus.UPLOAD_PENDING
                        )
                        logger.info(
                            f"{video_url} has pending/failed uploads. Status set to UPLOAD_PENDING."
                        )
                        current_status_for_log = MediaStatus.UPLOAD_PENDING
                    else:
                        logger.debug(
                            f"{video_url} is downloaded, some uploads may not be SUCCESS yet but none are PENDING/FAILED."
                        )
            logger.debug(
                f"Checked all uploads for {video_url}, not all completed. Final status for item: {current_status_for_log}"
            )
