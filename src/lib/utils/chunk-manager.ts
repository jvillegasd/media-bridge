/**
 * Chunk manager for sending large data through chrome.runtime.sendMessage
 * Based on: https://github.com/FoxRefire/ByeByeEXIF
 */

const CHUNK_SIZE = 25 * 1024 * 1024; // 25MB

interface ChunkMessage {
  type: '_chunk' | '_open';
  key: string;
  chunk?: string;
  index?: number;
  total?: number;
}

export class ChunkSender {
  private key: string;
  private message: string;
  private chunks: string[];

  constructor(key: string, message: any) {
    this.key = key;
    this.message = JSON.stringify(message);
    this.chunks = Array.from(
      { length: Math.ceil(this.message.length / CHUNK_SIZE) },
      (_, i) => this.message.slice(i * CHUNK_SIZE, i * CHUNK_SIZE + CHUNK_SIZE)
    );
  }

  async sendToRuntime(): Promise<void> {
    console.log(`[ChunkSender] Sending ${this.chunks.length} chunks for key ${this.key}`);
    
    // First, send open message with total chunks
    await chrome.runtime.sendMessage({
      type: '_open',
      key: this.key,
      total: this.chunks.length,
    });
    
    console.log(`[ChunkSender] OPEN message sent`);

    // Send all chunks in parallel
    const promises = this.chunks.map((chunk, index) => {
      console.log(`[ChunkSender] Sending chunk ${index}/${this.chunks.length}`);
      return chrome.runtime.sendMessage({
        type: '_chunk',
        chunk,
        index,
        key: this.key,
      });
    });

    await Promise.all(promises);
    console.log(`[ChunkSender] All chunks sent for key ${this.key}`);
  }
}

export class ChunkReceiver {
  private key: string;
  private chunks: ChunkMessage[] = [];
  private total?: number;
  private resolver?: (value: any) => void;

  constructor(key: string) {
    this.key = key;
  }

  receiveFromRuntime(): Promise<any> {
    return new Promise((resolve) => {
      this.resolver = resolve;

      const listener = (message: ChunkMessage, _sender: chrome.runtime.MessageSender, sendResponse: (response: boolean) => void) => {
        if (message.type === '_open' && message.key === this.key) {
          console.log(`[ChunkReceiver] Received OPEN for key ${this.key}, total chunks: ${message.total}`);
          this.total = message.total;
          sendResponse(true);
          return;
        }

        if (message.type === '_chunk' && message.key === this.key) {
          console.log(`[ChunkReceiver] Received chunk ${message.index}/${this.total} for key ${this.key}`);
          this.chunks.push(message);

          if (this.chunks.length === this.total) {
            console.log(`[ChunkReceiver] All chunks received, reassembling...`);
            const reassembled = this.chunks
              .sort((a, b) => (a.index || 0) - (b.index || 0))
              .map((obj) => obj.chunk)
              .join('');

            chrome.runtime.onMessage.removeListener(listener);
            console.log(`[ChunkReceiver] Reassembled ${reassembled.length} bytes`);
            resolve(JSON.parse(reassembled));
          }

          sendResponse(true);
        }
      };

      console.log(`[ChunkReceiver] Setting up listener for key ${this.key}`);
      chrome.runtime.onMessage.addListener(listener);
    });
  }
}

/**
 * Base64 encoding/decoding utilities (from ByeByeEXIF)
 */
const b64 = {
  decode: (s: string): Uint8Array => Uint8Array.from(atob(s), (c) => c.charCodeAt(0)),
  encode: (b: ArrayBuffer): string => btoa(Array.from(new Uint8Array(b)).map((e) => String.fromCharCode(e)).join('')),
};

/**
 * Convert segments to a transferrable format
 */
export async function segmentsToTransferrable(segments: Blob[]): Promise<any> {
  const segmentData = await Promise.all(
    segments.map(async (blob) => {
      const arrayBuffer = await blob.arrayBuffer();
      return {
        data: b64.encode(arrayBuffer),
        size: blob.size,
        type: blob.type,
      };
    })
  );

  return { segments: segmentData };
}

/**
 * Convert transferrable format back to Blobs
 */
export function transferrableToSegments(data: any): Blob[] {
  return data.segments.map((seg: any) => {
    const bytes = b64.decode(seg.data);
    // Create a new Uint8Array to ensure we have a proper ArrayBuffer
    const safeBytes = new Uint8Array(bytes);
    return new Blob([safeBytes], { type: seg.type || 'video/mp2t' });
  });
}

/**
 * Convert result blob to base64 for transfer
 */
export async function blobToBase64(blob: Blob): Promise<string> {
  const arrayBuffer = await blob.arrayBuffer();
  return b64.encode(arrayBuffer);
}

/**
 * Convert base64 back to blob
 */
export function base64ToBlob(base64: string, type: string = 'video/mp4'): Blob {
  const bytes = b64.decode(base64);
  // Create a new Uint8Array to ensure we have a proper ArrayBuffer
  const safeBytes = new Uint8Array(bytes);
  return new Blob([safeBytes], { type });
}

