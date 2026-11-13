/**
 * Capture bridge — a hidden, web-accessible extension page embedded by the
 * content script while saving a MediaSource capture.
 *
 * Protocol (over a MessagePort handed in with the setup message):
 *
 *   1. Setup `{ channel, token, downloadId }` arrives via window.postMessage.
 *      The page can see this iframe and post to it too, so nothing is trusted
 *      yet: the bridge asks the service worker to CAPTURE_CLAIM the token.
 *      Only a valid, unclaimed token for that exact `cap_` downloadId is
 *      accepted, and nothing touches IndexedDB before that. A failed claim
 *      does not lock the bridge, so a page racing a bogus claim cannot block
 *      the real one.
 *   2. On success the bridge posts `ready` on the port. Each `chunk` is then
 *      checked (slot, index range, no duplicates, running byte budget from the
 *      service worker), stored, and acknowledged with `ack`. The content script
 *      keeps its copy until the final result, so a failure here loses nothing.
 *   3. `done` -> the bridge verifies it has a contiguous run of chunks per slot
 *      and sends CAPTURE_FINALIZE with the counts it wrote itself.
 *
 * Any violation aborts the capture (CAPTURE_ABORT) and reports failure.
 */

import { storeChunk } from "../core/database/chunks";
import { MessageType } from "../shared/messages";
import { CAPTURE_BRIDGE_CHANNEL } from "../shared/constants";

const VALID_ID = /^cap_[a-z0-9_]{1,64}$/;
const VALID_TOKEN = /^[0-9a-f-]{36}$/;
const MAX_QUEUED_CLAIMS = 8;
const MAX_FAILED_CLAIMS = 16;
const HEARTBEAT_MS = 5_000;

type Slot = "video" | "audio";

interface Claim {
  token: string;
  downloadId: string;
  port: MessagePort;
}

let state: "idle" | "claiming" | "claimed" = "idle";
let failedClaims = 0;
const queue: Claim[] = [];

function send<T>(message: unknown): Promise<T> {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(response as T);
    });
  });
}

window.addEventListener("message", (event) => {
  const data = event.data;
  if (!data || data.channel !== CAPTURE_BRIDGE_CHANNEL || state === "claimed") return;
  const port = event.ports[0];
  const { token, downloadId } = data as { token?: unknown; downloadId?: unknown };
  if (
    !port ||
    typeof token !== "string" ||
    typeof downloadId !== "string" ||
    !VALID_TOKEN.test(token) ||
    !VALID_ID.test(downloadId)
  ) {
    port?.close();
    return;
  }
  if (queue.length >= MAX_QUEUED_CLAIMS || failedClaims >= MAX_FAILED_CLAIMS) {
    port.close();
    return;
  }
  queue.push({ token, downloadId, port });
  void processClaims();
});

async function processClaims(): Promise<void> {
  if (state !== "idle") return;
  const claim = queue.shift();
  if (!claim) return;
  state = "claiming";
  let res: { success: boolean; maxBytes?: number; maxChunks?: number } | undefined;
  try {
    res = await send({
      type: MessageType.CAPTURE_CLAIM,
      payload: { token: claim.token, downloadId: claim.downloadId },
    });
  } catch {
    res = undefined;
  }
  if (!res?.success || typeof res.maxBytes !== "number" || typeof res.maxChunks !== "number") {
    failedClaims++;
    claim.port.close();
    state = "idle";
    void processClaims();
    return;
  }
  state = "claimed";
  for (const other of queue.splice(0)) other.port.close();
  receive(claim, res.maxBytes, res.maxChunks);
}

function receive({ token, downloadId, port }: Claim, maxBytes: number, maxChunks: number): void {
  const seen: Record<Slot, Set<number>> = { video: new Set(), audio: new Set() };
  const writes: Promise<void>[] = [];
  let bytes = 0;
  let finished = false;
  let lastHeartbeat = 0;

  const fail = (error: string) => {
    if (finished) return;
    finished = true;
    port.postMessage({ type: "result", success: false, error });
    send({ type: MessageType.CAPTURE_ABORT, payload: { token, reason: error } }).catch(() => {});
    port.close();
  };

  const heartbeat = () => {
    const now = Date.now();
    if (now - lastHeartbeat < HEARTBEAT_MS) return;
    lastHeartbeat = now;
    send({ type: MessageType.CAPTURE_HEARTBEAT, payload: { token } }).catch(() => {});
  };

  const contiguous = (set: Set<number>) => {
    for (let i = 0; i < set.size; i++) if (!set.has(i)) return false;
    return true;
  };

  port.onmessage = async (ev) => {
    if (finished) return;
    const m = ev.data;

    if (m?.type === "chunk") {
      const slot: Slot | null = m.slot === "video" || m.slot === "audio" ? m.slot : null;
      const index = m.index;
      if (
        !slot ||
        !(m.data instanceof ArrayBuffer) ||
        !Number.isInteger(index) ||
        index < 0 ||
        index >= maxChunks ||
        seen[slot].has(index)
      ) {
        fail("Invalid capture chunk");
        return;
      }
      bytes += m.data.byteLength;
      if (bytes > maxBytes) {
        fail("Capture exceeds the memory limit set in Media Bridge settings");
        return;
      }
      seen[slot].add(index);
      heartbeat();
      const id = slot === "audio" ? `${downloadId}_a` : downloadId;
      const write = storeChunk(id, index, m.data).then(
        () => {
          if (!finished) port.postMessage({ type: "ack", slot, index });
        },
        (err) => fail(`Storing capture failed: ${err instanceof Error ? err.message : String(err)}`),
      );
      writes.push(write);
      return;
    }

    if (m?.type === "done") {
      await Promise.all(writes);
      if (finished) return;
      if (!contiguous(seen.video) || !contiguous(seen.audio)) {
        fail("Capture transfer is incomplete");
        return;
      }
      let response: { success?: boolean; error?: string } | undefined;
      try {
        response = await send({
          type: MessageType.CAPTURE_FINALIZE,
          payload: { token, downloadId, videoLength: seen.video.size, audioLength: seen.audio.size },
        });
      } catch (err) {
        fail(err instanceof Error ? err.message : String(err));
        return;
      }
      if (finished) return;
      finished = true;
      // On failure the service worker has already cleaned up this capture.
      port.postMessage({ type: "result", success: !!response?.success, error: response?.error });
      port.close();
    }
  };

  port.postMessage({ type: "ready" });
}
