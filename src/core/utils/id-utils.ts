const DOWNLOAD_ID_URL_PREFIX_LEN = 20;

/**
 * Generate a unique, filesystem-safe download ID from a URL.
 */
export function generateDownloadId(url: string): string {
  return `dl_${Date.now()}_${url.substring(0, DOWNLOAD_ID_URL_PREFIX_LEN).replace(/[^a-z0-9]/gi, "")}`;
}
