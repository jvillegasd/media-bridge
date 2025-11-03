import { MessageType } from '../shared/messages';
import { DASHDownloadResult } from '../lib/downloader/dash-downloader';
import { logger } from '../lib/utils/logger';
import { ChunkSender, ChunkReceiver, segmentsToTransferrable, base64ToBlob } from '../lib/utils/chunk-manager';

const OFFSCREEN_URL = chrome.runtime.getURL('offscreen/offscreen.html');

let creatingOffscreenDoc: Promise<void> | null = null;

// Use BLOBS reason to allow binary processing inside the offscreen document.
const OFFSCREEN_REASON = 'BLOBS' as chrome.offscreen.Reason;

async function ensureOffscreenDocument(): Promise<void> {
  if (!chrome.offscreen) {
    throw new Error('chrome.offscreen API is not available in this context.');
  }

  const hasDocument = await chrome.offscreen.hasDocument?.();
  if (hasDocument) {
    return;
  }

  if (!creatingOffscreenDoc) {
    creatingOffscreenDoc = chrome.offscreen.createDocument({
      url: OFFSCREEN_URL,
      reasons: [OFFSCREEN_REASON],
      justification: 'Merge media segments with FFmpeg.wasm.',
    }).catch((error) => {
      logger.error('Failed to create offscreen document:', error);
      throw error;
    }).finally(() => {
      creatingOffscreenDoc = null;
    });
  }

  await creatingOffscreenDoc;
}

async function runOffscreenMerge<T>(payload: any): Promise<T> {
  await ensureOffscreenDocument();

  try {
    const response = await chrome.runtime.sendMessage({
      type: MessageType.OFFSCREEN_MERGE_REQUEST,
      payload,
    });

    if (!response || !response.success) {
      throw new Error(response?.error || 'Offscreen merge failed');
    }

    return response.result as T;
  } catch (error) {
    logger.error('Offscreen merge request failed:', error);
    throw error instanceof Error ? error : new Error(String(error));
  }
}

export async function mergeHLSOffscreen(segments: Blob[], outputFilename?: string): Promise<Blob> {
  await ensureOffscreenDocument();

  // Generate unique keys for chunked transfer
  const requestKey = crypto.randomUUID();
  const responseKey = crypto.randomUUID();

  logger.info(`Starting chunked HLS merge with ${segments.length} segments...`);

  // Convert segments to transferrable format
  const transferrableData = await segmentsToTransferrable(segments);

  // Send initialization message and wait for offscreen to be ready
  logger.info('Waiting for offscreen document to be ready...');
  const readyResponse = await chrome.runtime.sendMessage({
    type: MessageType.OFFSCREEN_MERGE_REQUEST,
    operation: 'merge-hls',
    requestKey,
    responseKey,
    outputFilename,
  });
  
  logger.info('Offscreen ready, sending segments in chunks...');

  // Send segments in chunks
  const chunkSender = new ChunkSender(requestKey, transferrableData);
  await chunkSender.sendToRuntime();

  // Receive result in chunks
  const chunkReceiver = new ChunkReceiver(responseKey);
  const result = await chunkReceiver.receiveFromRuntime();

  // Convert base64 back to Blob
  return base64ToBlob(result.data, 'video/mp4');
}

export async function mergeDASHOffscreen(dashResult: DASHDownloadResult, outputFilename?: string): Promise<Blob> {
  const result = await runOffscreenMerge<{ blob: Blob }>({
    operation: 'merge-dash',
    dashResult,
    outputFilename,
  });

  return result.blob;
}

export async function closeOffscreenDocument(): Promise<void> {
  if (!chrome.offscreen) {
    return;
  }

  const hasDocument = await chrome.offscreen.hasDocument?.();
  if (hasDocument) {
    await chrome.offscreen.closeDocument();
  }
}


