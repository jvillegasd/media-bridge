/**
 * DRM detection utilities for HLS playlists
 * 
 * Detects DRM-protected content in HLS manifests to prevent downloads
 * of protected content that cannot be decrypted.
 */

/**
 * Check if an HLS manifest contains DRM-protected content
 * 
 * Detects various DRM systems:
 * - Apple FairPlay (skd:// URI or com.apple.streamingkeydelivery KEYFORMAT)
 * - Microsoft PlayReady (com.microsoft.playready KEYFORMAT)
 * - Adobe Flash Access (EXT-X-FAXS-CM tag)
 * 
 * @param manifest - The HLS playlist/manifest content as a string
 * @returns true if DRM is detected, false otherwise
 */
export function hasDrm(manifest: string): boolean {
  // Combine all DRM detection patterns
  const drmPatterns = [
    /#EXT-X-(?:SESSION-)?KEY:.*?URI="skd:\/\//, // Apple FairPlay
    /#EXT-X-(?:SESSION-)?KEY:.*?KEYFORMAT="com\.apple\.streamingkeydelivery"/, // Apple FairPlay
    /#EXT-X-(?:SESSION-)?KEY:.*?KEYFORMAT="com\.microsoft\.playready"/, // Microsoft PlayReady
    /#EXT-X-FAXS-CM:/, // Adobe Flash Access
  ];

  // Check if any DRM pattern matches
  return drmPatterns.some((pattern) => pattern.test(manifest));
}

/**
 * Check if an HLS manifest can be downloaded
 * 
 * Validates that the content is downloadable by checking:
 * - Not a live stream (EXT-X-MEDIA-SEQUENCE with non-zero value indicates live)
 * - No DRM protection detected
 * - Encryption method is either NONE or AES-128 (other methods may indicate DRM)
 * 
 * @param manifest - The HLS playlist/manifest content as a string
 * @param isLive - Optional flag indicating if this is a live stream
 * @param allowUnplayableFormats - If true, allows encrypted streams that aren't necessarily DRM
 * @returns true if the content can be downloaded, false otherwise
 */
export function canDownload(
  manifest: string,
  isLive: boolean = false,
  allowUnplayableFormats: boolean = false,
): boolean {
  // Check if it's a live stream
  if (isLive) {
    return false;
  }

  // Check for DRM
  if (hasDrm(manifest)) {
    return false;
  }

  // Check for unsupported encryption methods (if not allowing unplayable formats)
  if (!allowUnplayableFormats) {
    // Check for encryption methods other than NONE or AES-128
    const encryptionMethodPattern = /#EXT-X-KEY:METHOD=(?!NONE|AES-128)/;
    if (encryptionMethodPattern.test(manifest)) {
      return false;
    }
  }

  return true;
}

