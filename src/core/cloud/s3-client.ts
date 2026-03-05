/**
 * S3-compatible upload client with SigV4 request signing.
 * Works with AWS S3, Cloudflare R2, Backblaze B2, Wasabi, MinIO, and any
 * S3-compatible provider that accepts path-style or virtual-hosted-style URLs.
 *
 * Uses Web Crypto API — no external dependencies.
 */

import { BaseCloudProvider, ProgressCallback } from "./base-cloud-provider";
import { UploadError } from "../utils/errors";
import { logger } from "../utils/logger";

export interface S3Config {
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Custom endpoint for S3-compatible providers. Defaults to AWS S3 virtual-hosted URL. */
  endpoint?: string;
  /** Key prefix prepended to all uploaded object names. */
  prefix?: string;
}

export interface S3UploadResult {
  /** The public URL of the uploaded object (path-style). */
  url: string;
  key: string;
}

// S3 requires each part to be >= 5 MB (except the last). Use 10 MB parts.
// Threshold matches part size so every file >= 10 MB gets chunked progress.
// Files < 10 MB are uploaded as a single PUT (S3 rejects multipart parts < 5 MB).
const PART_SIZE = 10 * 1024 * 1024;
const MULTIPART_THRESHOLD = PART_SIZE;

export class S3Client extends BaseCloudProvider {
  readonly id = 's3' as const;
  private readonly config: S3Config;

  constructor(config: S3Config) {
    super();
    this.config = config;
  }

  async upload(
    blob: Blob,
    filename: string,
    onProgress?: ProgressCallback,
    signal?: AbortSignal,
  ): Promise<string> {
    const key = this.config.prefix
      ? `${this.config.prefix.replace(/\/$/, "")}/${filename}`
      : filename;

    let result: S3UploadResult;
    if (blob.size >= MULTIPART_THRESHOLD) {
      result = await this.multipartUpload(blob, key, onProgress, signal);
    } else {
      result = await this.putUpload(blob, key, onProgress, signal);
    }
    return result.url;
  }

  /** Single-part PUT upload for files < 10 MB */
  private async putUpload(
    blob: Blob,
    key: string,
    onProgress?: ProgressCallback,
    signal?: AbortSignal,
  ): Promise<S3UploadResult> {
    const url = this.objectUrl(key);
    const buffer = await blob.arrayBuffer();
    const payloadHash = await sha256hex(buffer);

    const now = new Date();
    const datetime = isoDatetime(now);
    const date = datetime.slice(0, 8);

    const headers: Record<string, string> = {
      "Content-Type": blob.type || "video/mp4",
      "Content-Length": String(blob.size),
      "x-amz-content-sha256": payloadHash,
      "x-amz-date": datetime,
      Host: new URL(url).host,
    };

    const authorization = await this.buildAuthorization(
      "PUT",
      new URL(url),
      headers,
      payloadHash,
      datetime,
      date,
    );
    headers["Authorization"] = authorization;
    delete headers["Host"]; // fetch adds it automatically

    const response = await fetch(url, {
      method: "PUT",
      headers,
      body: buffer,
      signal,
    });

    if (!response.ok) {
      const text = await response.text().catch(() => response.statusText);
      throw new UploadError(
        `S3 PUT failed (${response.status}): ${text}`,
        response.status,
      );
    }

    onProgress?.(blob.size, blob.size);
    logger.info(`S3 upload complete: ${key}`);
    return { url, key };
  }

  /** Multipart upload for files >= 10 MB */
  private async multipartUpload(
    blob: Blob,
    key: string,
    onProgress?: ProgressCallback,
    signal?: AbortSignal,
  ): Promise<S3UploadResult> {
    // 1. Initiate
    const uploadId = await this.initiateMultipart(key);
    const parts: Array<{ PartNumber: number; ETag: string }> = [];
    let uploadedBytes = 0;

    try {
      const totalParts = Math.ceil(blob.size / PART_SIZE);

      for (let i = 0; i < totalParts; i++) {
        signal?.throwIfAborted();
        const start = i * PART_SIZE;
        const end = Math.min(start + PART_SIZE, blob.size);
        const partBlob = blob.slice(start, end);
        const partNumber = i + 1;

        const etag = await this.uploadPart(key, uploadId, partNumber, partBlob, signal);
        parts.push({ PartNumber: partNumber, ETag: etag });

        uploadedBytes += partBlob.size;
        onProgress?.(uploadedBytes, blob.size);
      }

      // 2. Complete
      await this.completeMultipart(key, uploadId, parts);
    } catch (err) {
      // Abort on failure to avoid orphaned multipart uploads
      await this.abortMultipart(key, uploadId).catch((e) =>
        logger.warn("Failed to abort multipart upload:", e),
      );
      throw err;
    }

    const url = this.objectUrl(key);
    logger.info(`S3 multipart upload complete: ${key}`);
    return { url, key };
  }

  private async initiateMultipart(key: string): Promise<string> {
    const url = `${this.objectUrl(key)}?uploads`;
    const now = new Date();
    const datetime = isoDatetime(now);
    const date = datetime.slice(0, 8);
    const payloadHash = await sha256hex("");

    const headers: Record<string, string> = {
      "Content-Type": "video/mp4",
      "x-amz-content-sha256": payloadHash,
      "x-amz-date": datetime,
      Host: new URL(url).host,
    };
    const authorization = await this.buildAuthorization(
      "POST",
      new URL(url),
      headers,
      payloadHash,
      datetime,
      date,
    );
    headers["Authorization"] = authorization;
    delete headers["Host"];

    const response = await fetch(url, { method: "POST", headers });
    if (!response.ok) {
      const text = await response.text().catch(() => response.statusText);
      throw new UploadError(
        `Failed to initiate multipart upload (${response.status}): ${text}`,
        response.status,
      );
    }

    const xml = await response.text();
    const match = xml.match(/<UploadId>(.+?)<\/UploadId>/);
    if (!match?.[1]) throw new UploadError("No UploadId in response");
    return match[1];
  }

  private async uploadPart(
    key: string,
    uploadId: string,
    partNumber: number,
    blob: Blob,
    signal?: AbortSignal,
  ): Promise<string> {
    const baseUrl = this.objectUrl(key);
    const url = `${baseUrl}?partNumber=${partNumber}&uploadId=${encodeURIComponent(uploadId)}`;
    const buffer = await blob.arrayBuffer();
    const payloadHash = await sha256hex(buffer);
    const now = new Date();
    const datetime = isoDatetime(now);
    const date = datetime.slice(0, 8);

    const headers: Record<string, string> = {
      "Content-Length": String(blob.size),
      "x-amz-content-sha256": payloadHash,
      "x-amz-date": datetime,
      Host: new URL(url).host,
    };
    const authorization = await this.buildAuthorization(
      "PUT",
      new URL(url),
      headers,
      payloadHash,
      datetime,
      date,
    );
    headers["Authorization"] = authorization;
    delete headers["Host"];

    const response = await fetch(url, { method: "PUT", headers, body: buffer, signal });
    if (!response.ok) {
      const text = await response.text().catch(() => response.statusText);
      throw new UploadError(
        `Part ${partNumber} upload failed (${response.status}): ${text}`,
        response.status,
      );
    }

    const etag = response.headers.get("ETag") ?? "";
    return etag.replace(/"/g, "");
  }

  private async completeMultipart(
    key: string,
    uploadId: string,
    parts: Array<{ PartNumber: number; ETag: string }>,
  ): Promise<void> {
    const url = `${this.objectUrl(key)}?uploadId=${encodeURIComponent(uploadId)}`;
    const body = [
      "<CompleteMultipartUpload>",
      ...parts.map(
        (p) =>
          `<Part><PartNumber>${p.PartNumber}</PartNumber><ETag>${p.ETag}</ETag></Part>`,
      ),
      "</CompleteMultipartUpload>",
    ].join("");

    const now = new Date();
    const datetime = isoDatetime(now);
    const date = datetime.slice(0, 8);
    const payloadHash = await sha256hex(body);

    const headers: Record<string, string> = {
      "Content-Type": "application/xml",
      "x-amz-content-sha256": payloadHash,
      "x-amz-date": datetime,
      Host: new URL(url).host,
    };
    const authorization = await this.buildAuthorization(
      "POST",
      new URL(url),
      headers,
      payloadHash,
      datetime,
      date,
    );
    headers["Authorization"] = authorization;
    delete headers["Host"];

    const response = await fetch(url, { method: "POST", headers, body });
    if (!response.ok) {
      const text = await response.text().catch(() => response.statusText);
      throw new UploadError(
        `Failed to complete multipart upload: ${text}`,
        response.status,
      );
    }
  }

  private async abortMultipart(key: string, uploadId: string): Promise<void> {
    const url = `${this.objectUrl(key)}?uploadId=${encodeURIComponent(uploadId)}`;
    const now = new Date();
    const datetime = isoDatetime(now);
    const date = datetime.slice(0, 8);
    const payloadHash = await sha256hex("");

    const headers: Record<string, string> = {
      "x-amz-content-sha256": payloadHash,
      "x-amz-date": datetime,
      Host: new URL(url).host,
    };
    const authorization = await this.buildAuthorization(
      "DELETE",
      new URL(url),
      headers,
      payloadHash,
      datetime,
      date,
    );
    headers["Authorization"] = authorization;
    delete headers["Host"];

    await fetch(url, { method: "DELETE", headers });
  }

  /** Build SigV4 Authorization header value */
  private async buildAuthorization(
    method: string,
    url: URL,
    headers: Record<string, string>,
    payloadHash: string,
    datetime: string,
    date: string,
  ): Promise<string> {
    const region = this.config.region;
    const service = "s3";

    // Sorted canonical headers (lowercase names)
    const signedHeaderNames = Object.keys(headers)
      .map((k) => k.toLowerCase())
      .sort();

    const canonicalHeaders =
      signedHeaderNames
        .map((name) => {
          const value =
            headers[
              Object.keys(headers).find((k) => k.toLowerCase() === name)!
            ];
          return `${name}:${value.trim()}`;
        })
        .join("\n") + "\n";

    const signedHeaders = signedHeaderNames.join(";");

    // Canonical query string (sorted)
    const queryParams = Array.from(url.searchParams.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .join("&");

    // url.pathname uses RFC 3986 encoding which leaves sub-delimiters like
    // ( ) [ ] ! ' * unencoded, but SigV4 requires encoding everything except
    // unreserved chars (A-Za-z0-9 - _ . ~). Decode then re-encode per SigV4.
    const canonicalPath = sigV4EncodePath(decodeURIComponent(url.pathname));

    const canonicalRequest = [
      method,
      canonicalPath,
      queryParams,
      canonicalHeaders,
      signedHeaders,
      payloadHash,
    ].join("\n");

    const credentialScope = `${date}/${region}/${service}/aws4_request`;
    const stringToSign = [
      "AWS4-HMAC-SHA256",
      datetime,
      credentialScope,
      await sha256hex(canonicalRequest),
    ].join("\n");

    const signingKey = await deriveSigningKey(
      this.config.secretAccessKey,
      date,
      region,
      service,
    );
    const signature = buf2hex(await hmacSha256(signingKey, stringToSign));

    return (
      `AWS4-HMAC-SHA256 ` +
      `Credential=${this.config.accessKeyId}/${credentialScope}, ` +
      `SignedHeaders=${signedHeaders}, ` +
      `Signature=${signature}`
    );
  }

  private objectUrl(key: string): string {
    if (this.config.endpoint) {
      // Path-style: endpoint/bucket/key
      const base = this.config.endpoint.replace(/\/$/, "");
      return `${base}/${this.config.bucket}/${key}`;
    }
    // AWS virtual-hosted style
    return `https://${this.config.bucket}.s3.${this.config.region}.amazonaws.com/${key}`;
  }

  /** Verify credentials and bucket access (lightweight HEAD on the bucket) */
  async testConnection(): Promise<{ ok: boolean; error?: string }> {
    try {
      const url = this.bucketUrl();
      const now = new Date();
      const datetime = isoDatetime(now);
      const date = datetime.slice(0, 8);
      const payloadHash = await sha256hex("");

      const headers: Record<string, string> = {
        "x-amz-content-sha256": payloadHash,
        "x-amz-date": datetime,
        Host: new URL(url).host,
      };
      const authorization = await this.buildAuthorization(
        "HEAD",
        new URL(url),
        headers,
        payloadHash,
        datetime,
        date,
      );
      headers["Authorization"] = authorization;
      delete headers["Host"];

      const response = await fetch(url, { method: "HEAD", headers });
      if (response.ok || response.status === 403) {
        // 403 = bucket exists but no ListBucket permission — credentials are valid
        return { ok: true };
      }
      return {
        ok: false,
        error: `HTTP ${response.status}: ${response.statusText}`,
      };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  private bucketUrl(): string {
    if (this.config.endpoint) {
      const base = this.config.endpoint.replace(/\/$/, "");
      return `${base}/${this.config.bucket}`;
    }
    return `https://${this.config.bucket}.s3.${this.config.region}.amazonaws.com`;
  }
}

// ---- SigV4 URI encoding ----

/** Encode a single URI component per SigV4: only A-Za-z0-9 - _ . ~ are unreserved. */
function sigV4Encode(str: string): string {
  return encodeURIComponent(str)
    .replace(/!/g, "%21")
    .replace(/'/g, "%27")
    .replace(/\(/g, "%28")
    .replace(/\)/g, "%29")
    .replace(/\*/g, "%2A");
}

/** Encode a full path per SigV4, preserving '/' separators. */
function sigV4EncodePath(rawPath: string): string {
  return rawPath.split("/").map(sigV4Encode).join("/");
}

// ---- Crypto helpers ----

function buf2hex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function sha256hex(data: string | ArrayBuffer): Promise<string> {
  const buf: BufferSource =
    typeof data === "string" ? new TextEncoder().encode(data) : data;
  return buf2hex(await crypto.subtle.digest("SHA-256", buf));
}

async function hmacSha256(
  key: BufferSource,
  data: string,
): Promise<ArrayBuffer> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    key,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(data));
}

async function deriveSigningKey(
  secretKey: string,
  date: string,
  region: string,
  service: string,
): Promise<ArrayBuffer> {
  const kDate = await hmacSha256(
    new TextEncoder().encode(`AWS4${secretKey}`),
    date,
  );
  const kRegion = await hmacSha256(kDate, region);
  const kService = await hmacSha256(kRegion, service);
  return hmacSha256(kService, "aws4_request");
}

function isoDatetime(d: Date): string {
  return d.toISOString().replace(/[-:]/g, "").slice(0, 15) + "Z";
}
