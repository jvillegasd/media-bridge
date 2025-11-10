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
 */
export async function fetchResource(
  input: RequestInfo | URL,
  init?: RequestInit
): Promise<Response> {
  // If we're in a service worker/background context, use native fetch
  if (isServiceWorkerContext()) {
    return fetch(input, init);
  }

  // In content script context, delegate to background script
  return new Promise((resolve, reject) => {
    // Convert input to string URL
    let url: string;
    if (typeof input === 'string') {
      url = input;
    } else if (input instanceof URL) {
      url = input.href;
    } else if (input instanceof Request) {
      url = input.url;
      // Merge request init with provided init
      if (input.method) {
        init = { ...init, method: input.method };
      }
      if (input.headers) {
        const headers = new Headers(init?.headers);
        input.headers.forEach((value, key) => {
          headers.set(key, value);
        });
        init = { ...init, headers };
      }
      if (input.body) {
        init = { ...init, body: input.body };
      }
    } else {
      reject(new Error('Invalid input type'));
      return;
    }

    // Convert headers to plain object for JSON serialization
    const headersObj: Record<string, string> = {};
    if (init?.headers) {
      if (init.headers instanceof Headers) {
        init.headers.forEach((value, key) => {
          headersObj[key] = value;
        });
      } else if (Array.isArray(init.headers)) {
        init.headers.forEach(([key, value]) => {
          headersObj[key] = value;
        });
      } else {
        Object.assign(headersObj, init.headers);
      }
    }

    // Convert body to ArrayBuffer for serialization
    let bodyArrayBuffer: ArrayBuffer | null = null;
    if (init?.body) {
      if (init.body instanceof ArrayBuffer) {
        bodyArrayBuffer = init.body;
      } else if (init.body instanceof Blob) {
        // Blobs need to be converted to ArrayBuffer - we'll handle this async
        // For now, we'll need to read it first
        reject(new Error('Blob body not yet supported in fetchResource'));
        return;
      } else if (typeof init.body === 'string') {
        // Convert string to ArrayBuffer
        const encoder = new TextEncoder();
        bodyArrayBuffer = encoder.encode(init.body).buffer;
      } else if (init.body instanceof FormData || init.body instanceof URLSearchParams) {
        // FormData and URLSearchParams - convert to string representation
        // Note: This is a simplified approach, full FormData support would need more work
        reject(new Error('FormData/URLSearchParams body not yet supported in fetchResource'));
        return;
      } else {
        // Unknown body type
        bodyArrayBuffer = null;
      }
    }

    // Extract timeout from signal if present (for AbortSignal.timeout)
    let timeout: number | undefined;
    if (init?.signal && 'timeout' in init.signal) {
      // AbortSignal.timeout creates a signal with a timeout property
      // We can't serialize the signal, but we can extract the timeout value
      // For now, we'll use a default timeout or extract it if possible
      timeout = 5000; // Default timeout
    }

    chrome.runtime.sendMessage(
      {
        type: MessageType.FETCH_RESOURCE,
        payload: {
          input: url,
          init: {
            method: init?.method || 'GET',
            headers: headersObj,
            body: bodyArrayBuffer ? Array.from(new Uint8Array(bodyArrayBuffer)) : null,
            mode: init?.mode,
            credentials: init?.credentials,
            cache: init?.cache,
            redirect: init?.redirect,
            referrer: init?.referrer,
            referrerPolicy: init?.referrerPolicy,
            integrity: init?.integrity,
            timeout: timeout, // Pass timeout separately
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

