/**
 * File utility functions
 */

/**
 * Generate filename from URL with specific extension
 */
export function generateFilenameWithExtension(
  url: string,
  extension: string,
): string {
  try {
    const urlObj = new URL(url);
    const pathname = urlObj.pathname;
    const filename = pathname.split("/").pop() || "video";

    // Remove query parameters and existing extension
    const baseName = filename.split("?")[0].split(".")[0];

    return `${baseName}.${extension}`;
  } catch {
    // Fallback if URL parsing fails
    const timestamp = Date.now();
    return `video_${timestamp}.${extension}`;
  }
}

