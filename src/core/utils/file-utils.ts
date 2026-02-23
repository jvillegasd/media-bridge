/**
 * File utility functions
 */

/**
 * Sanitize filename by removing invalid characters
 */
export function sanitizeFilename(filename: string): string {
  // Remove or replace invalid filename characters
  // Windows: < > : " / \ | ? *
  // Unix/Mac: / and null
  return filename
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "") // Remove invalid characters
    .replace(/[\u200B-\u200D\u200E\u200F\uFEFF]/g, "") // Remove invisible Unicode characters (zero-width spaces, marks, etc.)
    .replace(/[\u202A-\u202E]/g, "") // Remove bidirectional formatting characters
    .replace(/\s+/g, " ") // Normalize whitespace
    .trim();
}

const MAX_FILENAME_TITLE_LENGTH = 100;
const MIN_WORD_BOUNDARY_POSITION = 50;

/**
 * Generate filename from tab title and website with specific extension
 */
export function generateFilenameFromTabInfo(
  tabTitle: string | undefined,
  website: string | undefined,
  extension: string,
): string {
  const parts: string[] = [];

  if (tabTitle) {
    // Sanitize and truncate tab title if too long
    let sanitizedTitle = sanitizeFilename(tabTitle);
    if (sanitizedTitle.length > MAX_FILENAME_TITLE_LENGTH) {
      // Truncate at last space to avoid cutting words mid-way
      const truncated = sanitizedTitle.substring(0, MAX_FILENAME_TITLE_LENGTH);
      const lastSpace = truncated.lastIndexOf(" ");
      sanitizedTitle = lastSpace > MIN_WORD_BOUNDARY_POSITION ? truncated.substring(0, lastSpace) : truncated;
    }
    parts.push(sanitizedTitle);
  }

  if (website) {
    // Sanitize website name
    const sanitizedWebsite = sanitizeFilename(website);
    parts.push(sanitizedWebsite);
  }

  // If we have at least one part, use the template
  if (parts.length > 0) {
    return `${parts.join(" - ")}.${extension}`;
  }

  // Fallback to timestamp if no info available
  const timestamp = Date.now();
  return `video_${timestamp}.${extension}`;
}

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
