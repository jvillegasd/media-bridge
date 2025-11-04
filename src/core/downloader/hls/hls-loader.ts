/**
 * HLS loader - fetches playlists and segments with retry logic
 */

import { logger } from '../../utils/logger';

type FetchFn<Data> = () => Promise<Data>;

async function fetchWithRetry<Data>(
  fetchFn: FetchFn<Data>,
  attempts: number = 3
): Promise<Data> {
  if (attempts < 1) {
    throw new Error('Attempts must be at least 1');
  }

  let countdown = attempts;
  let retryTime = 100;

  while (countdown--) {
    try {
      return await fetchFn();
    } catch (error) {
      if (countdown > 0) {
        logger.debug(`Fetch failed, retrying in ${retryTime}ms (${countdown} attempts left)`);
        await new Promise((resolve) => setTimeout(resolve, retryTime));
        retryTime *= 1.15; // Exponential backoff
      } else {
        logger.error('Fetch failed after all retry attempts');
        throw error;
      }
    }
  }

  throw new Error('Fetch failed after all retry attempts');
}

export class HlsLoader {
  /**
   * Fetch playlist as text
   */
  static async fetchText(url: string, attempts: number = 3): Promise<string> {
    const fetchFn: FetchFn<string> = async () => {
      const response = await fetch(url, {
        method: 'GET',
        mode: 'cors',
      });

      if (!response.ok) {
        throw new Error(`Failed to fetch playlist: ${response.statusText}`);
      }

      return response.text();
    };

    return fetchWithRetry(fetchFn, attempts);
  }

  /**
   * Fetch segment as ArrayBuffer
   */
  static async fetchArrayBuffer(url: string, attempts: number = 3): Promise<ArrayBuffer> {
    const fetchFn: FetchFn<ArrayBuffer> = async () => {
      const response = await fetch(url, {
        method: 'GET',
        mode: 'cors',
      });

      if (!response.ok) {
        throw new Error(`Failed to fetch segment: ${response.statusText}`);
      }

      return response.arrayBuffer();
    };

    return fetchWithRetry(fetchFn, attempts);
  }
}

