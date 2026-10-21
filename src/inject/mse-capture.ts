/**
 * MediaSource stream capture hook — runs in the page's MAIN world at document_start.
 *
 * Many players (hls.js, shaka, dash.js, proprietary ones) feed a <video> through
 * Media Source Extensions with a `blob:` src, so there is no downloadable URL and
 * the manifest may be obfuscated. This hook observes `SourceBuffer.appendBuffer()`
 * and keeps a copy of what the player feeds the decoder:
 *
 * - The latest initialization segment per SourceBuffer is always retained (tiny).
 * - Media segments are only retained while capture is armed by the user.
 * - Segments are keyed by their decode timestamp (fMP4 `tfdt`, WebM cluster
 *   timecode) so re-buffered segments after a seek dedupe and out-of-order
 *   appends are sorted back into timeline order on export.
 * - Sessions attached to an element with MediaKeys (EME), or whose init segment
 *   signals encryption (`encv`/`enca`/`tenc`/ContentEncryption), are flagged as
 *   DRM and are never exported.
 *
 * Communicates with the isolated-world content script over window.postMessage
 * on CAPTURE_CHANNEL. This file must stay dependency-free (it is injected into
 * every page before any page script runs).
 */

(() => {
  const CHANNEL = "__media_bridge_capture__";
  const GLOBAL_FLAG = "__mediaBridgeCaptureInstalled";
  const w = window as unknown as Record<string, unknown>;
  if (w[GLOBAL_FLAG] || typeof MediaSource === "undefined") return;
  w[GLOBAL_FLAG] = true;

  type Kind = "video" | "audio" | "unknown";
  type Container = "mp4" | "webm" | "unknown";

  interface Segment {
    data: Uint8Array;
    /** Decode time in the track's own units; falls back to append order */
    key: number;
    initId: number;
  }

  interface Track {
    mime: string;
    kind: Kind;
    container: Container;
    inits: Uint8Array[];
    currentInit: number;
    /** mdhd timescale per init (fMP4) / TimecodeScale-derived (WebM) */
    timescales: number[];
    segments: Map<string, Segment>;
    bytes: number;
    appendSeq: number;
    encrypted: boolean;
  }

  interface Session {
    id: number;
    mediaSource: MediaSource;
    tracks: Track[];
    blobUrl?: string;
    element?: HTMLMediaElement;
  }

  const sessions: Session[] = [];
  const sessionByMs = new WeakMap<MediaSource, Session>();
  const trackBySb = new WeakMap<SourceBuffer, Track>();
  const sessionBySb = new WeakMap<SourceBuffer, Session>();
  let nextSessionId = 1;
  let armed = false;
  let limitReached = false;
  let maxBytes = 1536 * 1024 * 1024;
  let totalBytes = 0;
  let statusTimer: ReturnType<typeof setTimeout> | null = null;

  // Keep references to natives before pages can tamper with them.
  const nativeAddSourceBuffer = MediaSource.prototype.addSourceBuffer;
  const nativeAppendBuffer = SourceBuffer.prototype.appendBuffer;
  const nativeCreateObjectURL = URL.createObjectURL;
  const nativePostMessage = window.postMessage.bind(window);

  // ---------------------------------------------------------------- helpers

  function post(msg: Record<string, unknown>, transfer: Transferable[] = []): void {
    nativePostMessage({ channel: CHANNEL, dir: "to-content", ...msg }, "*", transfer);
  }

  function kindFromMime(mime: string): Kind {
    const m = mime.toLowerCase();
    if (m.startsWith("video/")) return "video";
    if (m.startsWith("audio/")) return "audio";
    return "unknown";
  }

  function containerFromMime(mime: string): Container {
    const m = mime.toLowerCase();
    if (m.includes("webm")) return "webm";
    if (m.includes("mp4")) return "mp4";
    return "unknown";
  }

  function copyBytes(data: BufferSource): Uint8Array | null {
    if (data instanceof ArrayBuffer) return new Uint8Array(data.slice(0));
    if (ArrayBuffer.isView(data)) {
      return new Uint8Array(
        data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer,
      );
    }
    return null;
  }

  function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
    if (a.byteLength !== b.byteLength) return false;
    for (let i = 0; i < a.byteLength; i++) if (a[i] !== b[i]) return false;
    return true;
  }

  function containsAscii(buf: Uint8Array, needle: string): boolean {
    const n = needle.length;
    outer: for (let i = 0; i + n <= buf.byteLength; i++) {
      for (let j = 0; j < n; j++) {
        if (buf[i + j] !== needle.charCodeAt(j)) continue outer;
      }
      return true;
    }
    return false;
  }

  function readU32(b: Uint8Array, o: number): number {
    return ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
  }

  function boxType(b: Uint8Array, o: number): string {
    return String.fromCharCode(b[o + 4], b[o + 5], b[o + 6], b[o + 7]);
  }

  /** Iterate ISO-BMFF boxes in [start, end). Yields offset, size, type, header length. */
  function* boxes(b: Uint8Array, start: number, end: number) {
    let o = start;
    while (o + 8 <= end) {
      let size = readU32(b, o);
      const type = boxType(b, o);
      let header = 8;
      if (size === 1 && o + 16 <= end) {
        size = readU32(b, o + 8) * 2 ** 32 + readU32(b, o + 12);
        header = 16;
      } else if (size === 0) {
        size = end - o;
      }
      if (size < header || o + size > end) {
        // Truncated box: report what is left so callers can still split on it.
        yield { offset: o, size: end - o, type, header };
        return;
      }
      yield { offset: o, size, type, header };
      o += size;
    }
  }

  function findBox(b: Uint8Array, start: number, end: number, path: string[]) {
    let s = start;
    let e = end;
    let found: { offset: number; size: number; header: number } | null = null;
    for (const name of path) {
      found = null;
      for (const box of boxes(b, s, e)) {
        if (box.type === name) {
          found = box;
          break;
        }
      }
      if (!found) return null;
      s = found.offset + found.header;
      e = found.offset + found.size;
    }
    return found;
  }

  const MP4_INIT_BOXES = new Set(["ftyp", "moov"]);
  const MP4_MEDIA_BOXES = new Set(["styp", "sidx", "moof", "mdat", "emsg", "prft"]);

  /** Split an append into [init, media] parts. Either may be empty. */
  function splitMp4(b: Uint8Array): [Uint8Array | null, Uint8Array | null] {
    let firstMedia = -1;
    let sawInit = false;
    for (const box of boxes(b, 0, b.byteLength)) {
      if (MP4_INIT_BOXES.has(box.type)) sawInit = true;
      if (MP4_MEDIA_BOXES.has(box.type)) {
        firstMedia = box.offset;
        break;
      }
    }
    if (!sawInit) return [null, b];
    if (firstMedia < 0) return [b, null];
    return [b.subarray(0, firstMedia), b.subarray(firstMedia)];
  }

  function mp4Timescale(init: Uint8Array): number {
    const mdhd = findBox(init, 0, init.byteLength, ["moov", "trak", "mdia", "mdhd"]);
    if (!mdhd) return 0;
    const p = mdhd.offset + mdhd.header;
    const version = init[p];
    return version === 1 ? readU32(init, p + 20) : readU32(init, p + 12);
  }

  function mp4DecodeTime(seg: Uint8Array): number | null {
    const tfdt = findBox(seg, 0, seg.byteLength, ["moof", "traf", "tfdt"]);
    if (!tfdt) return null;
    const p = tfdt.offset + tfdt.header;
    const version = seg[p];
    if (version === 1) return readU32(seg, p + 4) * 2 ** 32 + readU32(seg, p + 8);
    return readU32(seg, p + 4);
  }

  // WebM / EBML
  const EBML_ID = [0x1a, 0x45, 0xdf, 0xa3];
  const CLUSTER_ID = [0x1f, 0x43, 0xb6, 0x75];

  function startsWith(b: Uint8Array, sig: number[], at = 0): boolean {
    if (b.byteLength < at + sig.length) return false;
    for (let i = 0; i < sig.length; i++) if (b[at + i] !== sig[i]) return false;
    return true;
  }

  function indexOfSig(b: Uint8Array, sig: number[], from = 0): number {
    for (let i = from; i + sig.length <= b.byteLength; i++) {
      if (startsWith(b, sig, i)) return i;
    }
    return -1;
  }

  /** Read an EBML variable-length integer. Returns [value, length]. */
  function readVint(b: Uint8Array, o: number): [number, number] | null {
    const first = b[o];
    if (first === undefined || first === 0) return null;
    let len = 1;
    while (len <= 8 && !(first & (0x80 >> (len - 1)))) len++;
    if (len > 8 || o + len > b.byteLength) return null;
    let value = first & (0xff >> len);
    for (let i = 1; i < len; i++) value = value * 256 + b[o + i];
    return [value, len];
  }

  function splitWebm(b: Uint8Array): [Uint8Array | null, Uint8Array | null] {
    if (!startsWith(b, EBML_ID)) return [null, b];
    const cluster = indexOfSig(b, CLUSTER_ID, 4);
    if (cluster < 0) return [b, null];
    return [b.subarray(0, cluster), b.subarray(cluster)];
  }

  function webmClusterTime(seg: Uint8Array): number | null {
    const c = indexOfSig(seg, CLUSTER_ID);
    if (c < 0) return null;
    const size = readVint(seg, c + 4);
    if (!size) return null;
    // Timecode (0xE7) is the first child of a Cluster in every muxer seen in practice.
    const p = c + 4 + size[1];
    if (seg[p] !== 0xe7) return null;
    const len = readVint(seg, p + 1);
    if (!len || len[0] > 8) return null;
    let t = 0;
    for (let i = 0; i < len[0]; i++) t = t * 256 + seg[p + 1 + len[1] + i];
    return t;
  }

  function detectEncryptedInit(track: Track, init: Uint8Array): boolean {
    if (track.container === "webm") {
      // ContentEncryption element ID 0x5035 inside ContentEncodings
      return indexOfSig(init, [0x50, 0x35]) >= 0 && indexOfSig(init, [0x6d, 0x80]) >= 0;
    }
    return containsAscii(init, "encv") || containsAscii(init, "enca") || containsAscii(init, "tenc");
  }

  // --------------------------------------------------------------- tracking

  function getSession(ms: MediaSource): Session {
    let s = sessionByMs.get(ms);
    if (!s) {
      s = { id: nextSessionId++, mediaSource: ms, tracks: [] };
      sessionByMs.set(ms, s);
      sessions.push(s);
    }
    return s;
  }

  function newTrack(mime: string): Track {
    return {
      mime,
      kind: kindFromMime(mime),
      container: containerFromMime(mime),
      inits: [],
      currentInit: -1,
      timescales: [],
      segments: new Map(),
      bytes: 0,
      appendSeq: 0,
      encrypted: false,
    };
  }

  function sessionElement(s: Session): HTMLMediaElement | undefined {
    if (s.element?.isConnected) return s.element;
    if (!s.blobUrl) return undefined;
    for (const el of Array.from(document.querySelectorAll("video, audio"))) {
      const m = el as HTMLMediaElement;
      if (m.src === s.blobUrl || m.currentSrc === s.blobUrl) {
        s.element = m;
        return m;
      }
    }
    return undefined;
  }

  function sessionHasDrm(s: Session): boolean {
    const el = sessionElement(s);
    if (el && (el as HTMLMediaElement & { mediaKeys?: unknown }).mediaKeys) return true;
    return s.tracks.some((t) => t.encrypted);
  }

  function onAppend(sb: SourceBuffer, data: BufferSource): void {
    let track = trackBySb.get(sb);
    if (!track) {
      // SourceBuffer created before our hook ran (should be rare at document_start)
      track = newTrack("");
      trackBySb.set(sb, track);
    }
    const bytes = copyBytes(data);
    if (!bytes || bytes.byteLength === 0) return;

    if (track.container === "unknown") {
      if (startsWith(bytes, EBML_ID)) track.container = "webm";
      else if (bytes.byteLength >= 8 && /^(ftyp|moov|styp|moof|sidx)$/.test(boxType(bytes, 0)))
        track.container = "mp4";
    }

    const [init, media] =
      track.container === "webm" ? splitWebm(bytes) : track.container === "mp4" ? splitMp4(bytes) : [null, bytes];

    if (init && init.byteLength > 0) {
      const existing = track.inits.findIndex((i) => sameBytes(i, init));
      if (existing >= 0) {
        track.currentInit = existing;
      } else {
        track.inits.push(init.slice());
        track.timescales.push(track.container === "mp4" ? mp4Timescale(init) : 1000);
        track.currentInit = track.inits.length - 1;
        if (detectEncryptedInit(track, init)) track.encrypted = true;
      }
    }

    if (!media || media.byteLength === 0) return;
    track.appendSeq++;
    // Throttled; keeps the UI aware of MSE sessions even when nothing is retained
    // (not armed, or DRM — the user must still see why capture is unavailable).
    scheduleStatus();

    const session = sessionBySb.get(sb);
    if (!armed || track.encrypted || track.currentInit < 0) return;
    if (session && sessionHasDrm(session)) return;

    const decodeTime = track.container === "mp4" ? mp4DecodeTime(media) : webmClusterTime(media);
    // Key includes the init group so different renditions never overwrite each other.
    const key = decodeTime ?? track.appendSeq * 1e-6;
    const mapKey = `${track.currentInit}:${key}`;
    const prev = track.segments.get(mapKey);
    if (prev) {
      track.bytes -= prev.data.byteLength;
      totalBytes -= prev.data.byteLength;
    }
    const stored = media.byteOffset === 0 && media.byteLength === bytes.byteLength ? bytes : media.slice();
    track.segments.set(mapKey, { data: stored, key, initId: track.currentInit });
    track.bytes += stored.byteLength;
    totalBytes += stored.byteLength;

    if (totalBytes >= maxBytes) {
      armed = false;
      limitReached = true;
    }
    scheduleStatus();
  }

  // ------------------------------------------------------------------ hooks

  MediaSource.prototype.addSourceBuffer = function (this: MediaSource, mime: string) {
    const sb = nativeAddSourceBuffer.call(this, mime);
    try {
      const session = getSession(this);
      const track = newTrack(mime);
      session.tracks.push(track);
      trackBySb.set(sb, track);
      sessionBySb.set(sb, session);
    } catch {
      // never break the player
    }
    return sb;
  };

  SourceBuffer.prototype.appendBuffer = function (this: SourceBuffer, data: BufferSource) {
    try {
      onAppend(this, data);
    } catch {
      // never break the player
    }
    return nativeAppendBuffer.call(this, data);
  };

  URL.createObjectURL = function (obj: Blob | MediaSource) {
    const url = nativeCreateObjectURL.call(URL, obj as Blob);
    try {
      if (typeof MediaSource !== "undefined" && obj instanceof MediaSource) {
        getSession(obj).blobUrl = url;
      }
    } catch {
      // ignore
    }
    return url;
  };

  // ----------------------------------------------------------------- status

  function trackSeconds(t: Track): number {
    let total = 0;
    const byInit = groupByInit(t);
    const best = pickBestGroup(t, byInit);
    if (!best) return 0;
    const segs = best.sort((a, b) => a.key - b.key);
    if (segs.length < 2) return 0;
    const ts = t.timescales[segs[0].initId] || 0;
    if (!ts) return 0;
    total = (segs[segs.length - 1].key - segs[0].key) / ts;
    return total > 0 && Number.isFinite(total) ? total : 0;
  }

  function buildStatus() {
    return {
      armed,
      limitReached,
      sessions: sessions
        .filter((s) => s.tracks.some((t) => t.appendSeq > 0))
        .map((s) => {
          const el = sessionElement(s) as HTMLVideoElement | undefined;
          const video = s.tracks.find((t) => t.kind === "video") ?? s.tracks[0];
          return {
            id: s.id,
            drm: sessionHasDrm(s),
            bytes: s.tracks.reduce((n, t) => n + t.bytes, 0),
            duration: el && Number.isFinite(el.duration) ? el.duration : undefined,
            width: el?.videoWidth || undefined,
            height: el?.videoHeight || undefined,
            capturedSeconds: video ? trackSeconds(video) : undefined,
            tracks: s.tracks.map((t) => ({
              kind: t.kind,
              mime: t.mime,
              segments: t.segments.size,
              bytes: t.bytes,
            })),
          };
        }),
    };
  }

  function scheduleStatus(): void {
    if (statusTimer) return;
    statusTimer = setTimeout(() => {
      statusTimer = null;
      post({ evt: "status", status: buildStatus() });
    }, 750);
  }

  // ----------------------------------------------------------------- export

  function groupByInit(t: Track): Map<number, Segment[]> {
    const groups = new Map<number, Segment[]>();
    for (const seg of t.segments.values()) {
      const g = groups.get(seg.initId);
      if (g) g.push(seg);
      else groups.set(seg.initId, [seg]);
    }
    return groups;
  }

  /** The rendition with the most captured bytes wins (players switch quality mid-stream). */
  function pickBestGroup(_t: Track, groups: Map<number, Segment[]>): Segment[] | null {
    let best: Segment[] | null = null;
    let bestBytes = -1;
    for (const segs of groups.values()) {
      const bytes = segs.reduce((n, s) => n + s.data.byteLength, 0);
      if (bytes > bestBytes) {
        best = segs;
        bestBytes = bytes;
      }
    }
    return best;
  }

  function exportSession(sessionId: number, reqId: string): void {
    const s = sessions.find((x) => x.id === sessionId) ?? largestSession();
    if (!s) {
      post({ evt: "export-result", reqId, error: "No captured stream on this page" });
      return;
    }
    if (sessionHasDrm(s)) {
      post({ evt: "export-result", reqId, error: "This stream is DRM-protected and cannot be saved" });
      return;
    }

    const tracks: { kind: Kind; mime: string; container: Container; chunks: ArrayBuffer[] }[] = [];
    const transfer: Transferable[] = [];
    for (const t of s.tracks) {
      const best = pickBestGroup(t, groupByInit(t));
      if (!best || best.length === 0) continue;
      best.sort((a, b) => a.key - b.key);
      const init = t.inits[best[0].initId];
      const chunks: ArrayBuffer[] = [init.slice().buffer as ArrayBuffer];
      for (const seg of best) chunks.push(seg.data.buffer as ArrayBuffer);
      chunks.forEach((c) => transfer.push(c));
      tracks.push({ kind: t.kind, mime: t.mime, container: t.container, chunks });
      // Ownership of segment buffers moves to the content script.
      totalBytes -= t.bytes;
      t.segments.clear();
      t.bytes = 0;
    }
    limitReached = false;

    if (tracks.length === 0) {
      post({ evt: "export-result", reqId, error: "Nothing captured yet — play the video while capture is on" });
      return;
    }
    post({ evt: "export-result", reqId, tracks }, transfer);
    scheduleStatus();
  }

  /** Session with the most captured bytes; otherwise the latest one that received media. */
  function largestSession(): Session | undefined {
    let best: Session | undefined;
    let bestBytes = 0;
    for (const s of sessions) {
      const b = s.tracks.reduce((n, t) => n + t.bytes, 0);
      if (b > bestBytes) {
        best = s;
        bestBytes = b;
      }
    }
    if (best) return best;
    for (let i = sessions.length - 1; i >= 0; i--) {
      if (sessions[i].tracks.some((t) => t.appendSeq > 0)) return sessions[i];
    }
    return undefined;
  }

  function discardAll(): void {
    for (const s of sessions) {
      for (const t of s.tracks) {
        t.segments.clear();
        t.bytes = 0;
      }
    }
    totalBytes = 0;
    limitReached = false;
  }

  /** Restart playback from 0 at high speed so the player buffers the whole stream quickly. */
  function boost(sessionId?: number): void {
    const s = (sessionId && sessions.find((x) => x.id === sessionId)) || largestSession() || sessions[sessions.length - 1];
    const el = s ? sessionElement(s) : (document.querySelector("video") as HTMLVideoElement | null);
    if (!el) return;
    try {
      el.muted = true;
      el.currentTime = 0;
      el.playbackRate = 16;
      void el.play()?.catch(() => {});
    } catch {
      // Some players clamp playbackRate; capture still works at normal speed.
    }
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const msg = event.data;
    if (!msg || msg.channel !== CHANNEL || msg.dir !== "to-page") return;
    switch (msg.cmd) {
      case "config":
        if (typeof msg.maxBytes === "number" && msg.maxBytes > 0) maxBytes = msg.maxBytes;
        if (msg.autoArm) armed = true;
        break;
      case "arm":
        armed = true;
        limitReached = false;
        break;
      case "boost":
        armed = true;
        limitReached = false;
        boost(msg.sessionId);
        break;
      case "disarm":
        armed = false;
        break;
      case "discard":
        discardAll();
        break;
      case "export":
        armed = false;
        exportSession(msg.sessionId, msg.reqId);
        return;
      case "status":
        break;
      default:
        return;
    }
    post({ evt: "status", status: buildStatus() });
  });
})();
