/**
 * HLS decryptor - handles AES-128 encrypted segments
 */

import { logger } from '../../utils/logger';
import { HlsKey } from './hls-parser';
import { HlsLoader } from './hls-loader';

export class HlsDecryptor {
  /**
   * Decrypt a segment using AES-128-CBC
   */
  static async decrypt(
    data: ArrayBuffer,
    keyData: ArrayBuffer,
    iv: Uint8Array
  ): Promise<ArrayBuffer> {
    try {
      const rawKey = await crypto.subtle.importKey(
        'raw',
        keyData,
        'AES-CBC',
        false,
        ['decrypt']
      );

      // Ensure IV is a proper Uint8Array with ArrayBuffer (not SharedArrayBuffer)
      // Create a new Uint8Array from the IV to ensure it has a proper ArrayBuffer
      const ivArray = new Uint8Array(iv);

      const decryptedData = await crypto.subtle.decrypt(
        {
          name: 'AES-CBC',
          iv: ivArray,
        },
        rawKey,
        data
      );

      return decryptedData;
    } catch (error) {
      logger.error('Decryption failed:', error);
      throw new Error(`Failed to decrypt segment: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Fetch and decrypt a segment if it has encryption
   */
  static async fetchAndDecrypt(
    fragmentUri: string,
    key: HlsKey,
    attempts: number = 3
  ): Promise<ArrayBuffer> {
    // Fetch the segment
    const segmentData = await HlsLoader.fetchArrayBuffer(fragmentUri, attempts);

    // If no encryption key, return as-is
    if (!key.uri) {
      return segmentData;
    }

    // Fetch the encryption key
    const keyData = await HlsLoader.fetchArrayBuffer(key.uri, attempts);

    // Generate IV if not provided
    let iv: Uint8Array;
    if (key.iv) {
      iv = key.iv;
    } else {
      // Default IV: 16 bytes of zeros
      iv = new Uint8Array(16);
    }

    // Decrypt the segment
    return this.decrypt(segmentData, keyData, iv);
  }
}

