/**
 * Generate a unique, filesystem-safe download ID from a URL.
 */
export function generateDownloadId(url: string): string {
  return `dl_${Date.now()}_${url.substring(0, 20).replace(/[^a-z0-9]/gi, "")}`;
}
