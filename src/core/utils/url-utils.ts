/**
 * URL utility functions
 */

export function resolveUrl(url: string, baseUrl: string): string {
  if (url.startsWith('http://') || url.startsWith('https://')) {
    return url;
  }

  try {
    const base = new URL(baseUrl);
    
    if (url.startsWith('/')) {
      return `${base.origin}${url}`;
    }
    
    return new URL(url, baseUrl).href;
  } catch (error) {
    // Fallback: simple string concatenation
    const base = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
    const relative = url.startsWith('/') ? url : `/${url}`;
    return `${base}${relative}`;
  }
}

export function isValidUrl(url: string): boolean {
  try {
    new URL(url);
    return true;
  } catch {
    return false;
  }
}

export function getDomain(url: string): string | null {
  try {
    const urlObj = new URL(url);
    return urlObj.hostname;
  } catch {
    return null;
  }
}

export function getBaseUrl(url: string): string {
  try {
    const urlObj = new URL(url);
    return `${urlObj.protocol}//${urlObj.host}${urlObj.pathname.substring(0, urlObj.pathname.lastIndexOf('/'))}`;
  } catch {
    return url.substring(0, url.lastIndexOf('/'));
  }
}

/**
 * Normalize URL by removing hash fragments and trailing slashes
 * Hash fragments don't affect the actual resource being downloaded
 */
export function normalizeUrl(url: string): string {
  try {
    const urlObj = new URL(url);
    // Remove hash fragment (it doesn't affect the downloaded content)
    urlObj.hash = '';
    return urlObj.href;
  } catch {
    // If URL parsing fails, just remove hash manually
    const hashIndex = url.indexOf('#');
    return hashIndex >= 0 ? url.substring(0, hashIndex) : url;
  }
}

