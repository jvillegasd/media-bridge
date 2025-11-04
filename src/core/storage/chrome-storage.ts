/**
 * Chrome Storage API wrapper
 */

import { logger } from '../utils/logger';

export class ChromeStorage {
  /**
   * Get value from chrome.storage.local
   */
  static async get<T>(key: string): Promise<T | null> {
    try {
      const result = await chrome.storage.local.get(key);
      return result[key] ?? null;
    } catch (error) {
      logger.error(`Failed to get storage key ${key}:`, error);
      return null;
    }
  }

  /**
   * Set value in chrome.storage.local
   */
  static async set(key: string, value: any): Promise<void> {
    try {
      await chrome.storage.local.set({ [key]: value });
    } catch (error) {
      logger.error(`Failed to set storage key ${key}:`, error);
      throw error;
    }
  }

  /**
   * Remove value from chrome.storage.local
   */
  static async remove(key: string): Promise<void> {
    try {
      await chrome.storage.local.remove(key);
    } catch (error) {
      logger.error(`Failed to remove storage key ${key}:`, error);
      throw error;
    }
  }

  /**
   * Get all values
   */
  static async getAll(): Promise<Record<string, any>> {
    try {
      return await chrome.storage.local.get(null);
    } catch (error) {
      logger.error('Failed to get all storage:', error);
      return {};
    }
  }

  /**
   * Clear all storage
   */
  static async clear(): Promise<void> {
    try {
      await chrome.storage.local.clear();
    } catch (error) {
      logger.error('Failed to clear storage:', error);
      throw error;
    }
  }
}

