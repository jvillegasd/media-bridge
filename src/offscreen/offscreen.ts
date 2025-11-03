import { MessageType } from '../shared/messages';
import { SegmentMerger } from '../lib/merger/segment-merger';
import { DASHDownloadResult } from '../lib/downloader/dash-downloader';
import { logger } from '../lib/utils/logger';
import { ChunkReceiver, ChunkSender, transferrableToSegments, blobToBase64 } from '../lib/utils/chunk-manager';

let merger: SegmentMerger | null = null;

async function getMerger(): Promise<SegmentMerger> {
  if (!merger) {
    merger = new SegmentMerger();
  }
  return merger;
}

/**
 * Convert serialized blob data back to real Blobs
 * We transfer segments as { data: ArrayBuffer, size: number, type: string }
 */
function reconstructBlob(data: any): Blob {
  if (data instanceof Blob) {
    return data;
  }
  
  // Check if it's our custom format { data: ArrayBuffer, size, type }
  if (data && typeof data === 'object' && data.data) {
    if (data.data instanceof ArrayBuffer) {
      return new Blob([data.data], { type: data.type || 'video/mp2t' });
    }
  }
  
  // Direct ArrayBuffer
  if (data instanceof ArrayBuffer) {
    return new Blob([data]);
  }
  
  // Uint8Array or similar
  if (data.buffer instanceof ArrayBuffer) {
    return new Blob([data.buffer]);
  }
  
  logger.error('Cannot reconstruct blob from data:', data);
  throw new Error('Cannot reconstruct blob from data');
}

async function handleMergeRequest(payload: any) {
  const currentMerger = await getMerger();
  const { operation, segments, dashResult, outputFilename } = payload;

  if (operation === 'merge-hls') {
    logger.info(`Received ${segments?.length || 0} segments for HLS merge`);
    logger.info(`First segment type: ${segments?.[0]?.constructor?.name}, is Blob: ${segments?.[0] instanceof Blob}`);
    
    // Segments should already be Blobs when transferred via chrome.runtime.sendMessage
    // But if they're not, try to reconstruct them
    const blobSegments = segments.map((seg: any, index: number) => {
      if (seg instanceof Blob) {
        logger.debug(`Segment ${index} is already a Blob`);
        return seg;
      }
      logger.warn(`Segment ${index} is not a Blob, attempting reconstruction`, seg);
      return reconstructBlob(seg);
    });
    
    return {
      blob: await currentMerger.mergeHLS(blobSegments, { outputFilename }),
    };
  }

  if (operation === 'merge-dash') {
    return {
      blob: await currentMerger.mergeDASH(dashResult as DASHDownloadResult, { outputFilename }),
    };
  }

  throw new Error(`Unsupported offscreen merge operation: ${operation}`);
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type !== MessageType.OFFSCREEN_MERGE_REQUEST) {
    return;
  }

  if (message.operation === 'merge-hls') {
    logger.info('Offscreen: Setting up chunked HLS merge handler...');
    
    // Set up chunk receiver FIRST before responding
    const chunkReceiver = new ChunkReceiver(message.requestKey);
    const receivePromise = chunkReceiver.receiveFromRuntime();
    
    // Send response to acknowledge we're ready
    sendResponse({ success: true, ready: true });
    
    (async () => {
      try {
        logger.info('Offscreen: Waiting for chunked segments...');
        
        // Wait for segments to arrive in chunks
        const transferrableData = await receivePromise;
        
        logger.info('Offscreen: Reconstructing segments from chunks...');
        const segments = transferrableToSegments(transferrableData);
        
        logger.info(`Offscreen: Merging ${segments.length} segments...`);
        const currentMerger = await getMerger();
        const resultBlob = await currentMerger.mergeHLS(segments, { outputFilename: message.outputFilename });
        
        logger.info(`Offscreen: Merge complete, sending result back (${resultBlob.size} bytes)...`);
        
        // Convert result to base64 for chunked transfer
        const base64Data = await blobToBase64(resultBlob);
        
        // Send result back in chunks
        const chunkSender = new ChunkSender(message.responseKey, { data: base64Data });
        await chunkSender.sendToRuntime();
        
        logger.info('Offscreen: Result sent successfully');
      } catch (error) {
        logger.error('Offscreen merge failed:', error);
      }
    })();
    
    return true;
  }

  // Old non-chunked handling for DASH (can be updated later)
  (async () => {
    try {
      const result = await handleMergeRequest(message.payload);
      sendResponse({ success: true, result });
    } catch (error) {
      logger.error('Offscreen merge failed:', error);
      sendResponse({
        success: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  })();

  return true; // Keep the message channel open for async response
});


