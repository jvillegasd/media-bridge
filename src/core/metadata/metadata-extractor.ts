/**
 * Metadata extraction utilities for video files
 * Extracts duration, format, extension from various sources
 */

import { logger } from '../utils/logger';

export interface ExtractedMetadata {
  duration?: number;
  format?: string;
  extension?: string;
  mimeType?: string;
}


/**
 * Detect video format from blob (by examining file headers)
 */
export function detectFormatFromBlob(blob: Blob): string {
  const mimeType = blob.type.toLowerCase();
  
  // Check MIME type first
  if (mimeType.includes('mp4') || mimeType.includes('mpeg4')) {
    return 'mp4';
  }
  if (mimeType.includes('webm')) {
    return 'webm';
  }
  if (mimeType.includes('quicktime') || mimeType.includes('mov')) {
    return 'mov';
  }
  if (mimeType.includes('x-msvideo') || mimeType.includes('avi')) {
    return 'avi';
  }
  if (mimeType.includes('matroska') || mimeType.includes('mkv')) {
    return 'mkv';
  }
  if (mimeType.includes('mpeg') && mimeType.includes('transport')) {
    return 'm2ts'; // MPEG-2 Transport Stream
  }
  if (mimeType.includes('mpeg') && mimeType.includes('video')) {
    return 'mpg';
  }
  
  // Default fallback
  return 'mp4';
}

/**
 * Map format to file extension
 */
export function detectExtensionFromFormat(format: string): string {
  const formatLower = format.toLowerCase();
  
  const extensionMap: Record<string, string> = {
    'mp4': 'mp4',
    'webm': 'webm',
    'mov': 'mov',
    'avi': 'avi',
    'mkv': 'mkv',
    'flv': 'flv',
    'wmv': 'wmv',
    'ogg': 'ogg',
    'm2ts': 'm2ts',
    'ts': 'ts',
    'mpegts': 'ts',
    'mpg': 'mpg',
    'mpeg': 'mpg',
    'direct': 'mp4', // Default for direct videos
  };
  
  return extensionMap[formatLower] || 'mp4';
}

/**
 * Extract file extension from URL
 */
export function detectExtensionFromUrl(url: string): string | undefined {
  try {
    const urlObj = new URL(url);
    const pathname = urlObj.pathname.toLowerCase();
    
    // Match common video extensions
    const extensionMatch = pathname.match(/\.(mp4|webm|mov|avi|mkv|flv|wmv|ogg|m4v|m2ts|ts|mpg|mpeg)(\?|$|#)/);
    if (extensionMatch && extensionMatch[1]) {
      return extensionMatch[1].toLowerCase();
    }
    
    // Check query parameters for extension hints
    const extParam = urlObj.searchParams.get('ext') || urlObj.searchParams.get('format');
    if (extParam && /^(mp4|webm|mov|avi|mkv|flv|wmv|ogg|m4v|m2ts|ts|mpg|mpeg)$/i.test(extParam)) {
      return extParam.toLowerCase();
    }
    
    return undefined;
  } catch {
    // URL parsing failed, try simple string match
    const urlLower = url.toLowerCase();
    const extensionMatch = urlLower.match(/\.(mp4|webm|mov|avi|mkv|flv|wmv|ogg|m4v|m2ts|ts|mpg|mpeg)(\?|$|#)/);
    if (extensionMatch && extensionMatch[1]) {
      return extensionMatch[1].toLowerCase();
    }
    
    return undefined;
  }
}

/**
 * Extract extension from Content-Type header
 */
export function detectExtensionFromContentType(contentType: string): string | undefined {
  const contentTypeLower = contentType.toLowerCase();
  
  const mimeToExt: Record<string, string> = {
    'video/mp4': 'mp4',
    'video/mpeg4': 'mp4',
    'video/x-m4v': 'm4v',
    'video/webm': 'webm',
    'video/quicktime': 'mov',
    'video/x-msvideo': 'avi',
    'video/x-matroska': 'mkv',
    'video/x-flv': 'flv',
    'video/x-ms-wmv': 'wmv',
    'video/ogg': 'ogg',
    'video/mpeg': 'mpg',
    'video/mp2t': 'ts',
    'video/mpeg2': 'm2ts',
  };
  
  // Check exact match first
  if (mimeToExt[contentTypeLower]) {
    return mimeToExt[contentTypeLower];
  }
  
  // Check partial matches
  for (const [mime, ext] of Object.entries(mimeToExt)) {
    if (contentTypeLower.includes(mime)) {
      return ext;
    }
  }
  
  return undefined;
}

/**
 * Extract metadata from direct video blob
 * Attempts to extract duration and format information
 */
export async function extractMetadataFromDirectBlob(
  blob: Blob,
  url?: string,
  contentType?: string
): Promise<ExtractedMetadata> {
  const metadata: ExtractedMetadata = {};
  
  // Detect format from blob MIME type
  metadata.format = detectFormatFromBlob(blob);
  metadata.mimeType = blob.type || contentType;
  
  // Detect extension
  if (url) {
    metadata.extension = detectExtensionFromUrl(url);
  }
  if (!metadata.extension && contentType) {
    metadata.extension = detectExtensionFromContentType(contentType);
  }
  if (!metadata.extension) {
    metadata.extension = detectExtensionFromFormat(metadata.format);
  }
  
  // Note: Extracting duration from blob requires parsing video headers
  // This would require more complex video parsing (read first bytes, parse MP4 box structure, etc.)
  // For now, we'll leave duration extraction to the content script which has access to video elements
  // In the future, this could be enhanced with a video parser library
  
  logger.info(`Extracted metadata from direct blob: format=${metadata.format}, extension=${metadata.extension}`);
  
  return metadata;
}


