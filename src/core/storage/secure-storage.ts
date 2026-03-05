/**
 * Passphrase-based AES-GCM encryption for secrets stored in chrome.storage.local.
 *
 * Key derivation: PBKDF2 (SHA-256, 100 000 iterations) → AES-GCM 256-bit key.
 * Passphrase is cached in chrome.storage.session so the user only enters it once
 * per browser session (session storage is cleared on browser close).
 *
 * Zero external dependencies — uses only the Web Crypto API.
 */

const PBKDF2_ITERATIONS = 100_000;
const SESSION_KEY = "s3_passphrase";

export interface EncryptedBlob {
  encrypted: string; // base64 ciphertext
  iv: string;        // base64 IV (12 bytes)
  salt: string;      // base64 PBKDF2 salt (16 bytes)
}

function toBase64(buf: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(buf)));
}

function fromBase64(b64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(b64);
  const buf = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) buf[i] = binary.charCodeAt(i);
  return buf;
}

async function deriveKey(passphrase: string, salt: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    enc.encode(passphrase),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: salt as BufferSource, iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export class SecureStorage {
  static async encrypt(plaintext: string, passphrase: string): Promise<EncryptedBlob> {
    const salt = crypto.getRandomValues(new Uint8Array(16)) as Uint8Array<ArrayBuffer>;
    const iv = crypto.getRandomValues(new Uint8Array(12)) as Uint8Array<ArrayBuffer>;
    const key = await deriveKey(passphrase, salt);
    const enc = new TextEncoder();
    const ciphertext = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: iv.buffer },
      key,
      enc.encode(plaintext),
    );
    return {
      encrypted: toBase64(ciphertext),
      iv: toBase64(iv.buffer),
      salt: toBase64(salt.buffer),
    };
  }

  static async decrypt(blob: EncryptedBlob, passphrase: string): Promise<string> {
    const salt = fromBase64(blob.salt);
    const iv = fromBase64(blob.iv);
    const ciphertext = fromBase64(blob.encrypted);
    const key = await deriveKey(passphrase, salt);
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: iv.buffer },
      key,
      ciphertext.buffer,
    );
    return new TextDecoder().decode(plaintext);
  }

  static async setPassphrase(passphrase: string): Promise<void> {
    await chrome.storage.session.set({ [SESSION_KEY]: passphrase });
  }

  static async getPassphrase(): Promise<string | null> {
    const result = await chrome.storage.session.get(SESSION_KEY);
    return (result[SESSION_KEY] as string) ?? null;
  }

  static async clearPassphrase(): Promise<void> {
    await chrome.storage.session.remove(SESSION_KEY);
  }
}
