import logging
import time
from enum import Enum
from typing import Any, Callable, Optional, Type, TypeVar

logger = logging.getLogger("media_bridge.error_handler")


class ErrorCategory(Enum):
    """Categories of errors that can occur during media processing."""

    TEMPORARY = "temporary"  # Can be retried
    PERMANENT = "permanent"  # Should not be retried
    UNKNOWN = "unknown"  # Default category


class RetryableError(Exception):
    """Base class for errors that can be retried."""

    def __init__(self, message: str, category: ErrorCategory = ErrorCategory.TEMPORARY):
        super().__init__(message)
        self.category = category


class NonRetryableError(Exception):
    """Base class for errors that should not be retried."""

    def __init__(self, message: str, category: ErrorCategory = ErrorCategory.PERMANENT):
        super().__init__(message)
        self.category = category


# Common error types
class NetworkError(RetryableError):
    """Network-related errors that can be retried."""

    pass


class AuthenticationError(NonRetryableError):
    """Authentication errors that should not be retried."""

    pass


class ResourceNotFoundError(NonRetryableError):
    """Resource not found errors that should not be retried."""

    pass


class ValidationError(NonRetryableError):
    """Validation errors that should not be retried."""

    pass


# Upload-specific error types
class UploadError(RetryableError):
    """Base class for upload-related errors."""

    pass


class UploadQuotaError(NonRetryableError):
    """Error when upload quota is exceeded."""

    pass


class UploadSizeError(NonRetryableError):
    """Error when file size exceeds limits."""

    pass


class UploadFormatError(NonRetryableError):
    """Error when file format is not supported."""

    pass


class UploadPermissionError(NonRetryableError):
    """Error when user lacks permission to upload."""

    pass


class UploadTimeoutError(UploadError):
    """Error when upload times out."""

    pass


class UploadConnectionError(UploadError):
    """Error when upload connection fails."""

    pass


class UploadRateLimitError(UploadError):
    """Error when upload rate limit is hit."""

    pass


T = TypeVar("T")


def with_retry(
    func: Callable[..., T],
    max_attempts: int = 3,
    initial_delay: float = 1.0,
    max_delay: float = 30.0,
    backoff_factor: float = 2.0,
    retryable_exceptions: tuple[Type[Exception], ...] = (RetryableError,),
    on_retry: Optional[Callable[[Exception, int], None]] = None,
) -> Callable[..., T]:
    """
    Decorator that adds retry logic to a function.

    Args:
        func: The function to retry
        max_attempts: Maximum number of retry attempts
        initial_delay: Initial delay between retries in seconds
        max_delay: Maximum delay between retries in seconds
        backoff_factor: Factor to increase delay between retries
        retryable_exceptions: Tuple of exception types that should trigger a retry
        on_retry: Optional callback function called before each retry

    Returns:
        Wrapped function with retry logic
    """

    def wrapper(*args: Any, **kwargs: Any) -> T:
        last_exception: Optional[Exception] = None
        delay = initial_delay

        for attempt in range(max_attempts):
            try:
                return func(*args, **kwargs)
            except retryable_exceptions as e:
                last_exception = e
                if attempt < max_attempts - 1:
                    if on_retry:
                        on_retry(e, attempt + 1)

                    logger.warning(
                        f"Attempt {attempt + 1}/{max_attempts} failed: {str(e)}. "
                        f"Retrying in {delay:.1f} seconds..."
                    )

                    time.sleep(delay)
                    delay = min(delay * backoff_factor, max_delay)
                else:
                    logger.error(
                        f"All {max_attempts} attempts failed. Last error: {str(e)}"
                    )
            except Exception as e:
                # Non-retryable exception, re-raise immediately
                logger.error(f"Non-retryable error occurred: {str(e)}")
                raise

        # If we get here, all retries failed
        raise last_exception

    return wrapper


def categorize_error(error: Exception) -> ErrorCategory:
    """
    Categorize an exception into an error category.

    Args:
        error: The exception to categorize

    Returns:
        ErrorCategory indicating if the error is retryable
    """
    if isinstance(error, RetryableError):
        return error.category
    elif isinstance(error, NonRetryableError):
        return error.category

    # Default categorization based on error type
    if isinstance(error, (ConnectionError, TimeoutError)):
        return ErrorCategory.TEMPORARY
    elif isinstance(error, (ValueError, TypeError, AttributeError)):
        return ErrorCategory.PERMANENT

    return ErrorCategory.UNKNOWN


def format_error_message(error: Exception, include_traceback: bool = False) -> str:
    """
    Format an error message for CLI output.

    Args:
        error: The exception to format
        include_traceback: Whether to include the traceback

    Returns:
        Formatted error message
    """
    category = categorize_error(error)
    message = f"{error.__class__.__name__}: {str(error)}"

    if category == ErrorCategory.TEMPORARY:
        message += " (This error is temporary and can be retried)"
    elif category == ErrorCategory.PERMANENT:
        message += " (This error is permanent and cannot be retried)"

    if include_traceback:
        import traceback

        message += (
            f"\n\nTraceback:\n{''.join(traceback.format_tb(error.__traceback__))}"
        )

    return message
