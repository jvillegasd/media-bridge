/**
 * Fetch utility functions with retry logic
 */

import { FetchFn } from '../types';
import { MessageType } from '../../shared/messages';

/**
 * Check if we're running in a service worker/background context
 */
function isServiceWorkerContext(): boolean {
  return typeof chrome !== 'undefined' && 
         typeof chrome.runtime !== 'undefined' &&
         typeof window === 'undefined';
}

/**
 * Fetch resource - delegates to background script if in content script context
 * Uses native fetch if in background/service worker context
 * 
 * Supports:
 * - String URLs or URL objects
 * - Simple HTTP methods (GET, POST, HEAD, etc.)
 * - Plain object headers
 * - ArrayBuffer or string request bodies
 */
export async function fetchResource(
  input: string | URL,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: ArrayBuffer | string;
    mode?: RequestMode;
  }
): Promise<Response> {
  // If we're in a service worker/background context, use native fetch
  if (isServiceWorkerContext()) {
    return fetch(input, init);
  }

  // In content script context, delegate to background script
  return new Promise((resolve, reject) => {
    // Convert input to string URL
    const url = typeof input === 'string' ? input : input.href;

    // Convert body to ArrayBuffer for serialization
    let bodyArrayBuffer: ArrayBuffer | null = null;
    if (init?.body) {
      if (init.body instanceof ArrayBuffer) {
        bodyArrayBuffer = init.body;
      } else if (typeof init.body === 'string') {
        // Convert string to ArrayBuffer
        const encoder = new TextEncoder();
        bodyArrayBuffer = encoder.encode(init.body).buffer;
      }
    }

    chrome.runtime.sendMessage(
      {
        type: MessageType.FETCH_RESOURCE,
        payload: {
          input: url,
          init: {
            method: init?.method || 'GET',
            headers: init?.headers || {},
            body: bodyArrayBuffer ? Array.from(new Uint8Array(bodyArrayBuffer)) : null,
            mode: init?.mode,
          },
        },
      },
      (messageResponse) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }

        const [response, error] = messageResponse;

        if (response === null) {
          reject(error || new Error('Unknown fetch error'));
        } else {
          // Use undefined on a 204 - No Content
          const body = response.body ? new Blob([response.body]) : undefined;
          resolve(
            new Response(body, {
              status: response.status,
              statusText: response.statusText,
              headers: new Headers(response.headers || {}),
            })
          );
        }
      }
    );
  });
}

async function fetchWithRetry<Data>(
  fetchFn: FetchFn<Data>,
  attempts: number = 1
): Promise<Data> {
  if (attempts < 1) {
    throw new Error("Attempts less then 1");
  }
  let countdown = attempts;
  let retryTime = 100;
  while (countdown--) {
    try {
      return await fetchFn();
    } catch (e) {
      if (countdown > 0) {
        await new Promise((resolve) => setTimeout(resolve, retryTime));
        retryTime *= 1.15;
      }
    }
  }
  throw new Error("Fetch error");
}

export async function fetchText(url: string, attempts: number = 1) {
  const fetchFn: FetchFn<string> = () => fetchResource(url).then((res) => res.text());
  return fetchWithRetry(fetchFn, attempts);
}

export async function fetchArrayBuffer(url: string, attempts: number = 1) {
  const fetchFn: FetchFn<ArrayBuffer> = () =>
    fetchResource(url).then((res) => res.arrayBuffer());
  return fetchWithRetry(fetchFn, attempts);
}

export const FetchLoader = {
  fetchText,
  fetchArrayBuffer,
};

