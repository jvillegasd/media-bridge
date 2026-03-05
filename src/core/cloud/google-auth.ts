/**
 * Google OAuth using chrome.identity.launchWebAuthFlow.
 * Users supply their own OAuth client ID via the options page.
 */

import { AuthError } from "../utils/errors";
import { logger } from "../utils/logger";
import { ChromeStorage } from "../storage/chrome-storage";

const CLIENT_ID_STORAGE_KEY = "google_client_id";
const TOKEN_STORAGE_KEY = "google_access_token";

// Google OAuth scopes
export const GOOGLE_DRIVE_SCOPES = [
  "https://www.googleapis.com/auth/drive.file",
];

export interface GoogleAuthConfig {
  clientId?: string;
}

export class GoogleAuth {
  /**
   * Set Google OAuth client ID
   */
  static async setClientId(clientId: string): Promise<void> {
    await ChromeStorage.set(CLIENT_ID_STORAGE_KEY, clientId);
  }

  /**
   * Get Google OAuth client ID
   */
  static async getClientId(): Promise<string | null> {
    return await ChromeStorage.get<string>(CLIENT_ID_STORAGE_KEY);
  }

  /**
   * Authenticate with Google via launchWebAuthFlow (implicit grant).
   */
  static async authenticate(scopes: string[]): Promise<string> {
    try {
      const clientId = await this.getClientId();
      if (!clientId) {
        throw new AuthError(
          "Google OAuth client ID not configured. Please set it in options.",
        );
      }

      const redirectUrl = chrome.identity.getRedirectURL();
      const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
      authUrl.searchParams.set("client_id", clientId);
      authUrl.searchParams.set("redirect_uri", redirectUrl);
      authUrl.searchParams.set("response_type", "token");
      authUrl.searchParams.set("scope", scopes.join(" "));

      const responseUrl = await new Promise<string>((resolve, reject) => {
        chrome.identity.launchWebAuthFlow(
          { url: authUrl.toString(), interactive: true },
          (callbackUrl) => {
            if (chrome.runtime.lastError) {
              reject(
                new AuthError(
                  `Authentication failed: ${chrome.runtime.lastError.message}`,
                ),
              );
              return;
            }
            if (!callbackUrl) {
              reject(new AuthError("No callback URL received"));
              return;
            }
            resolve(callbackUrl);
          },
        );
      });

      // Extract access_token from the URL fragment
      const hashParams = new URLSearchParams(
        new URL(responseUrl).hash.slice(1),
      );
      const token = hashParams.get("access_token");
      if (!token) {
        throw new AuthError("No access token in OAuth response");
      }

      await ChromeStorage.set(TOKEN_STORAGE_KEY, token);
      logger.info("Google authentication successful");

      return token;
    } catch (error) {
      logger.error("Google authentication failed:", error);
      throw error instanceof AuthError
        ? error
        : new AuthError(`Authentication failed: ${error}`);
    }
  }

  /**
   * Get access token (refresh if needed)
   */
  static async getAccessToken(scopes: string[]): Promise<string> {
    const storedToken = await ChromeStorage.get<string>(TOKEN_STORAGE_KEY);

    if (storedToken && (await this.isTokenValid(storedToken))) {
      return storedToken;
    }

    // Token expired or not found, re-authenticate
    return await this.authenticate(scopes);
  }

  /**
   * Check if token is valid
   */
  private static async isTokenValid(token: string): Promise<boolean> {
    try {
      const response = await fetch(
        "https://www.googleapis.com/oauth2/v1/tokeninfo?access_token=" + token,
      );
      return response.ok;
    } catch {
      return false;
    }
  }

  /**
   * Revoke token and sign out
   */
  static async signOut(): Promise<void> {
    const token = await ChromeStorage.get<string>(TOKEN_STORAGE_KEY);

    if (token) {
      try {
        await fetch(
          `https://accounts.google.com/o/oauth2/revoke?token=${token}`,
        );
      } catch (error) {
        logger.warn("Failed to revoke token:", error);
      }
    }

    await ChromeStorage.remove(TOKEN_STORAGE_KEY);
    logger.info("Signed out successfully");
  }

  /**
   * Check if user is authenticated
   */
  static async isAuthenticated(): Promise<boolean> {
    const token = await ChromeStorage.get<string>(TOKEN_STORAGE_KEY);
    if (!token) {
      return false;
    }
    return await this.isTokenValid(token);
  }
}
