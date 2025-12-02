/**
 * DRM detection utilities for HLS playlists
 * 
 * Detects DRM-protected content in HLS manifests to prevent downloads
 * of protected content that cannot be decrypted.
 */

import { DownloadError } from "./errors";

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
 * Check if an HLS manifest can be decrypted
 * 
 * Validates that the content can be decrypted by checking:
 * - Encryption method is either NONE or AES-128 (other methods cannot be decrypted)
 * 
 * Note: This function only checks decryption capability, not DRM protection.
 * Use hasDrm() to check for DRM-protected content.
 * 
 * @param manifest - The HLS playlist/manifest content as a string
 * @returns true if the content can be decrypted, false otherwise
 */
export function canDecrypt(manifest: string): boolean {
  // Check for unsupported encryption methods
  // Only NONE or AES-128 are supported for decryption
  const encryptionMethodPattern = /#EXT-X-KEY:METHOD=(?!NONE|AES-128)/;
  if (encryptionMethodPattern.test(manifest)) {
    return false;
  }

  return true;
}

/**
 * Validate if an HLS manifest can be downloaded
 * 
 * Checks both DRM protection and decryption capability, throwing appropriate
 * errors if the content cannot be downloaded.
 * 
 * @param manifest - The HLS playlist/manifest content as a string
 * @throws {DownloadError} If the manifest contains DRM-protected content
 * @throws {DownloadError} If the manifest uses unsupported encryption methods
 */
export function canDownloadHLSManifest(manifest: string): void {
  // Check for DRM protection
  if (hasDrm(manifest)) {
    throw new DownloadError("Cannot download DRM-protected content");
  }

  // Check for decryption capability
  if (!canDecrypt(manifest)) {
    throw new DownloadError("Cannot decrypt content with unsupported encryption method");
  }
}

