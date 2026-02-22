/**
 * Crypto utilities for decrypting encrypted video data
 * Supports AES-CBC decryption for encrypted video segments (e.g., HLS with AES-128)
 */

import { fetchArrayBuffer } from "./fetch-utils";
import { logger } from "./logger";

/** Encryption key information for fragment decryption */
export interface FragmentKey {
  iv: string | null;
  uri: string | null;
}

/**
 * Decrypt data using AES-CBC algorithm
 * @param data - Encrypted data as ArrayBuffer
 * @param keyData - Encryption key as ArrayBuffer
 * @param iv - Initialization vector as Uint8Array
 * @returns Decrypted data as ArrayBuffer
 */
export async function decrypt(
  data: ArrayBuffer,
  keyData: ArrayBuffer,
  iv: Uint8Array,
): Promise<ArrayBuffer> {
  const rawKey = await crypto.subtle.importKey(
    "raw",
    keyData,
    "aes-cbc",
    false,
    ["decrypt"],
  );

  const decryptData = await crypto.subtle.decrypt(
    {
      name: "aes-cbc",
      iv: iv as unknown as BufferSource,
    },
    rawKey,
    data,
  );

  return decryptData;
}

/**
 * Decrypt a single fragment if encrypted (AES-128)
 * Returns data unchanged if not encrypted
 * @param key - Fragment encryption key info (IV and URI)
 * @param data - Fragment data as ArrayBuffer
 * @param fetchAttempts - Number of fetch retry attempts for the encryption key
 * @param abortSignal - Optional abort signal for cancellation
 * @returns Decrypted data as ArrayBuffer (or original if not encrypted)
 */
export async function decryptFragment(
  key: FragmentKey,
  data: ArrayBuffer,
  fetchAttempts: number = 3,
  abortSignal?: AbortSignal,
  headers?: Record<string, string>,
): Promise<ArrayBuffer> {
  // If no key URI or IV, fragment is not encrypted
  if (!key.uri || !key.iv) {
    return data;
  }

  try {
    // Fetch the encryption key
    const keyArrayBuffer = await fetchArrayBuffer(key.uri, fetchAttempts, abortSignal, headers);

    // Convert IV from hex string to Uint8Array
    // IV should be 16 bytes for AES-128
    const hexString = key.iv.startsWith("0x") ? key.iv.slice(2) : key.iv;
    const ivBytes = new Uint8Array(16);

    // Parse hex string (should be 32 hex chars = 16 bytes)
    // Pad or truncate to exactly 16 bytes
    const normalizedHex = hexString.padEnd(32, "0").slice(0, 32);
    for (let i = 0; i < 16; i++) {
      const hexByte = normalizedHex.substring(i * 2, i * 2 + 2);
      ivBytes[i] = parseInt(hexByte, 16);
    }

    // Decrypt the data
    const decryptedData = await decrypt(data, keyArrayBuffer, ivBytes);
    return decryptedData;
  } catch (error) {
    logger.error(`Failed to decrypt fragment:`, error);
    throw new Error(
      `Decryption failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

/**
 * Crypto decryptor utility object
 */
export const CryptoDecryptor = {
  decrypt,
  decryptFragment,
};
