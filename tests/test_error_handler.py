import time
from unittest.mock import Mock

import pytest

from media_bridge.error_handler import (
    AuthenticationError,
    ErrorCategory,
    NetworkError,
    NonRetryableError,
    RetryableError,
    UploadConnectionError,
    UploadError,
    UploadFormatError,
    UploadPermissionError,
    UploadQuotaError,
    UploadRateLimitError,
    UploadSizeError,
    UploadTimeoutError,
    categorize_error,
    format_error_message,
    with_retry,
)


def test_error_categories():
    """Test error category enums."""
    assert ErrorCategory.TEMPORARY.value == "temporary"
    assert ErrorCategory.PERMANENT.value == "permanent"
    assert ErrorCategory.UNKNOWN.value == "unknown"


def test_retryable_error():
    """Test RetryableError class."""
    error = RetryableError("Test error")
    assert str(error) == "Test error"
    assert error.category == ErrorCategory.TEMPORARY

    error = RetryableError("Custom category", ErrorCategory.UNKNOWN)
    assert error.category == ErrorCategory.UNKNOWN


def test_non_retryable_error():
    """Test NonRetryableError class."""
    error = NonRetryableError("Test error")
    assert str(error) == "Test error"
    assert error.category == ErrorCategory.PERMANENT

    error = NonRetryableError("Custom category", ErrorCategory.UNKNOWN)
    assert error.category == ErrorCategory.UNKNOWN


def test_specific_error_types():
    """Test specific error types."""
    network_error = NetworkError("Connection failed")
    assert isinstance(network_error, RetryableError)
    assert network_error.category == ErrorCategory.TEMPORARY

    auth_error = AuthenticationError("Invalid credentials")
    assert isinstance(auth_error, NonRetryableError)
    assert auth_error.category == ErrorCategory.PERMANENT


def test_upload_error_types():
    """Test upload-specific error types."""
    # Test retryable upload errors
    upload_error = UploadError("General upload error")
    assert isinstance(upload_error, RetryableError)
    assert upload_error.category == ErrorCategory.TEMPORARY

    timeout_error = UploadTimeoutError("Upload timed out")
    assert isinstance(timeout_error, UploadError)
    assert timeout_error.category == ErrorCategory.TEMPORARY

    connection_error = UploadConnectionError("Connection failed")
    assert isinstance(connection_error, UploadError)
    assert connection_error.category == ErrorCategory.TEMPORARY

    rate_limit_error = UploadRateLimitError("Rate limit exceeded")
    assert isinstance(rate_limit_error, UploadError)
    assert rate_limit_error.category == ErrorCategory.TEMPORARY

    # Test non-retryable upload errors
    quota_error = UploadQuotaError("Quota exceeded")
    assert isinstance(quota_error, NonRetryableError)
    assert quota_error.category == ErrorCategory.PERMANENT

    size_error = UploadSizeError("File too large")
    assert isinstance(size_error, NonRetryableError)
    assert size_error.category == ErrorCategory.PERMANENT

    format_error = UploadFormatError("Unsupported format")
    assert isinstance(format_error, NonRetryableError)
    assert format_error.category == ErrorCategory.PERMANENT

    permission_error = UploadPermissionError("Permission denied")
    assert isinstance(permission_error, NonRetryableError)
    assert permission_error.category == ErrorCategory.PERMANENT


def test_with_retry_success():
    """Test retry decorator with successful operation."""
    mock_func = Mock(return_value="success")
    decorated_func = with_retry(mock_func, max_attempts=3)

    result = decorated_func()
    assert result == "success"
    assert mock_func.call_count == 1


def test_with_retry_eventual_success():
    """Test retry decorator with eventual success after retries."""
    mock_func = Mock(
        side_effect=[NetworkError("Failed"), NetworkError("Failed"), "success"]
    )
    decorated_func = with_retry(mock_func, max_attempts=3)

    result = decorated_func()
    assert result == "success"
    assert mock_func.call_count == 3


def test_with_retry_max_attempts():
    """Test retry decorator with max attempts reached."""
    mock_func = Mock(side_effect=NetworkError("Failed"))
    decorated_func = with_retry(mock_func, max_attempts=3)

    with pytest.raises(NetworkError):
        decorated_func()
    assert mock_func.call_count == 3


def test_with_retry_non_retryable():
    """Test retry decorator with non-retryable error."""
    mock_func = Mock(side_effect=AuthenticationError("Invalid credentials"))
    decorated_func = with_retry(mock_func, max_attempts=3)

    with pytest.raises(AuthenticationError):
        decorated_func()
    assert mock_func.call_count == 1


def test_with_retry_callback():
    """Test retry decorator with callback function."""
    mock_func = Mock(side_effect=[NetworkError("Failed"), "success"])
    mock_callback = Mock()

    decorated_func = with_retry(mock_func, max_attempts=3, on_retry=mock_callback)
    result = decorated_func()

    assert result == "success"
    assert mock_func.call_count == 2
    assert mock_callback.call_count == 1
    assert isinstance(mock_callback.call_args[0][0], NetworkError)
    assert mock_callback.call_args[0][1] == 1


def test_with_retry_delay():
    """Test retry decorator delay between attempts."""
    mock_func = Mock(side_effect=[NetworkError("Failed"), "success"])
    decorated_func = with_retry(
        mock_func, max_attempts=3, initial_delay=0.1, max_delay=0.2, backoff_factor=2.0
    )

    start_time = time.time()
    result = decorated_func()
    end_time = time.time()

    assert result == "success"
    assert mock_func.call_count == 2
    # Should have waited at least 0.1 seconds
    assert end_time - start_time >= 0.1


def test_categorize_error():
    """Test error categorization."""
    # Test retryable errors
    assert categorize_error(NetworkError("Failed")) == ErrorCategory.TEMPORARY
    assert categorize_error(ConnectionError()) == ErrorCategory.TEMPORARY
    assert categorize_error(TimeoutError()) == ErrorCategory.TEMPORARY
    assert categorize_error(UploadError("Failed")) == ErrorCategory.TEMPORARY
    assert categorize_error(UploadTimeoutError("Timeout")) == ErrorCategory.TEMPORARY
    assert (
        categorize_error(UploadConnectionError("Connection failed"))
        == ErrorCategory.TEMPORARY
    )
    assert (
        categorize_error(UploadRateLimitError("Rate limit")) == ErrorCategory.TEMPORARY
    )

    # Test non-retryable errors
    assert categorize_error(AuthenticationError("Invalid")) == ErrorCategory.PERMANENT
    assert categorize_error(ValueError("Invalid value")) == ErrorCategory.PERMANENT
    assert categorize_error(TypeError("Invalid type")) == ErrorCategory.PERMANENT
    assert categorize_error(UploadQuotaError("Quota")) == ErrorCategory.PERMANENT
    assert categorize_error(UploadSizeError("Size")) == ErrorCategory.PERMANENT
    assert categorize_error(UploadFormatError("Format")) == ErrorCategory.PERMANENT
    assert (
        categorize_error(UploadPermissionError("Permission")) == ErrorCategory.PERMANENT
    )

    # Test unknown errors
    assert categorize_error(Exception("Unknown")) == ErrorCategory.UNKNOWN


def test_format_error_message():
    """Test error message formatting."""
    # Test retryable error
    error = NetworkError("Connection failed")
    message = format_error_message(error)
    assert "NetworkError: Connection failed" in message
    assert "temporary" in message.lower()
    assert "can be retried" in message.lower()

    # Test non-retryable error
    error = AuthenticationError("Invalid credentials")
    message = format_error_message(error)
    assert "AuthenticationError: Invalid credentials" in message
    assert "permanent" in message.lower()
    assert "cannot be retried" in message.lower()

    # Test upload errors
    error = UploadTimeoutError("Upload timed out")
    message = format_error_message(error)
    assert "UploadTimeoutError: Upload timed out" in message
    assert "temporary" in message.lower()
    assert "can be retried" in message.lower()

    error = UploadQuotaError("Quota exceeded")
    message = format_error_message(error)
    assert "UploadQuotaError: Quota exceeded" in message
    assert "permanent" in message.lower()
    assert "cannot be retried" in message.lower()

    # Test with traceback
    error = ValueError("Invalid value")
    message = format_error_message(error, include_traceback=True)
    assert "ValueError: Invalid value" in message
    assert "Traceback:" in message
