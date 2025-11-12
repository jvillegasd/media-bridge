/**
 * FFmpeg singleton utility for managing FFmpeg instance
 */

import { FFmpeg } from "@ffmpeg/ffmpeg";
import { logger } from "./logger";

/**
 * Singleton FFmpeg instance
 */
export class FFmpegSingleton {
  private static instance: FFmpeg | null = null;
  private static isLoaded = false;

  static async getInstance(): Promise<FFmpeg> {
    if (!FFmpegSingleton.instance) {
      FFmpegSingleton.instance = new FFmpeg();
      logger.info("Loading FFmpeg...");

      try {
        await FFmpegSingleton.instance.load({
          coreURL: chrome.runtime.getURL("./ffmpeg/core/ffmpeg-core.js"),
          wasmURL: chrome.runtime.getURL("./ffmpeg/core/ffmpeg-core.wasm"),
        });

        // Set up logging
        FFmpegSingleton.instance.on("log", ({ message }) => {
          logger.debug("FFmpeg:", message);
        });

        FFmpegSingleton.isLoaded = true;
        logger.info("FFmpeg loaded successfully");
      } catch (error) {
        logger.error("Failed to load FFmpeg:", error);
        FFmpegSingleton.instance = null;
        FFmpegSingleton.isLoaded = false;
        throw new Error(
          `FFmpeg initialization failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    return FFmpegSingleton.instance;
  }

  static isFFmpegLoaded(): boolean {
    return FFmpegSingleton.isLoaded;
  }
}
