def validate_url(url):
    """Validate the given URL to ensure it is a valid video URL."""
    # Basic validation logic can be implemented here
    return url.startswith("http") and "youtube.com" in url

def format_output(message):
    """Format the output message for better readability."""
    return f"[INFO] {message}"