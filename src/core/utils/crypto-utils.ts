/**
 * Crypto utilities for decrypting encrypted video data
 * Supports AES-CBC decryption for encrypted video segments (e.g., HLS with AES-128)
 */

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
      iv: iv,
    },
    rawKey,
    data,
  );

  return decryptData;
}

/**
 * Crypto decryptor utility object
 */
export const CryptoDecryptor = {
  decrypt,
};

