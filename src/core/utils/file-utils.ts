/**
 * File utility functions
 */

/**
 * Sanitize filename by removing invalid characters
 */
function sanitizeFilename(filename: string): string {
  // Remove or replace invalid filename characters
  // Windows: < > : " / \ | ? *
  // Unix/Mac: / and null
  return filename
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "") // Remove invalid characters
    .replace(/\s+/g, " ") // Normalize whitespace
    .trim();
}

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
    if (sanitizedTitle.length > 100) {
      sanitizedTitle = sanitizedTitle.substring(0, 100);
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
