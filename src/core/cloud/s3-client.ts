/**
 * S3-compatible upload client with SigV4 request signing.
 * Works with AWS S3, Cloudflare R2, Backblaze B2, Wasabi, MinIO, and any
 * S3-compatible provider that accepts path-style or virtual-hosted-style URLs.
 *
 * Uses Web Crypto API — no external dependencies.
 */

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

// Multipart threshold: 100 MB
const MULTIPART_THRESHOLD = 100 * 1024 * 1024;
// Part size for multipart: 10 MB
const PART_SIZE = 10 * 1024 * 1024;

export class S3Client {
  private readonly config: S3Config;

  constructor(config: S3Config) {
    this.config = config;
  }

  async uploadBlob(
    blob: Blob,
    filename: string,
    onProgress?: (uploadedBytes: number, totalBytes: number) => void,
  ): Promise<S3UploadResult> {
    const key = this.config.prefix ? `${this.config.prefix.replace(/\/$/, "")}/${filename}` : filename;

    if (blob.size >= MULTIPART_THRESHOLD) {
      return this.multipartUpload(blob, key, onProgress);
    }
    return this.putUpload(blob, key, onProgress);
  }

  /** Single-part PUT upload for files < 100 MB */
  private async putUpload(
    blob: Blob,
    key: string,
    onProgress?: (uploaded: number, total: number) => void,
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
      "Host": new URL(url).host,
    };

    const authorization = await this.buildAuthorization(
      "PUT", new URL(url), headers, payloadHash, datetime, date,
    );
    headers["Authorization"] = authorization;
    delete headers["Host"]; // fetch adds it automatically

    const response = await fetch(url, {
      method: "PUT",
      headers,
      body: buffer,
    });

    if (!response.ok) {
      const text = await response.text().catch(() => response.statusText);
      throw new UploadError(`S3 PUT failed (${response.status}): ${text}`, response.status);
    }

    onProgress?.(blob.size, blob.size);
    logger.info(`S3 upload complete: ${key}`);
    return { url, key };
  }

  /** Multipart upload for files >= 100 MB */
  private async multipartUpload(
    blob: Blob,
    key: string,
    onProgress?: (uploaded: number, total: number) => void,
  ): Promise<S3UploadResult> {
    // 1. Initiate
    const uploadId = await this.initiateMultipart(key);
    const parts: Array<{ PartNumber: number; ETag: string }> = [];
    let uploadedBytes = 0;

    try {
      const totalParts = Math.ceil(blob.size / PART_SIZE);

      for (let i = 0; i < totalParts; i++) {
        const start = i * PART_SIZE;
        const end = Math.min(start + PART_SIZE, blob.size);
        const partBlob = blob.slice(start, end);
        const partNumber = i + 1;

        const etag = await this.uploadPart(key, uploadId, partNumber, partBlob);
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
      "Host": new URL(url).host,
    };
    const authorization = await this.buildAuthorization(
      "POST", new URL(url), headers, payloadHash, datetime, date,
    );
    headers["Authorization"] = authorization;
    delete headers["Host"];

    const response = await fetch(url, { method: "POST", headers });
    if (!response.ok) {
      throw new UploadError(`Failed to initiate multipart upload: ${response.statusText}`, response.status);
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
      "Host": new URL(url).host,
    };
    const authorization = await this.buildAuthorization(
      "PUT", new URL(url), headers, payloadHash, datetime, date,
    );
    headers["Authorization"] = authorization;
    delete headers["Host"];

    const response = await fetch(url, { method: "PUT", headers, body: buffer });
    if (!response.ok) {
      throw new UploadError(`Part ${partNumber} upload failed: ${response.statusText}`, response.status);
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
        (p) => `<Part><PartNumber>${p.PartNumber}</PartNumber><ETag>${p.ETag}</ETag></Part>`,
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
      "Host": new URL(url).host,
    };
    const authorization = await this.buildAuthorization(
      "POST", new URL(url), headers, payloadHash, datetime, date,
    );
    headers["Authorization"] = authorization;
    delete headers["Host"];

    const response = await fetch(url, { method: "POST", headers, body });
    if (!response.ok) {
      const text = await response.text().catch(() => response.statusText);
      throw new UploadError(`Failed to complete multipart upload: ${text}`, response.status);
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
      "Host": new URL(url).host,
    };
    const authorization = await this.buildAuthorization(
      "DELETE", new URL(url), headers, payloadHash, datetime, date,
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

    const canonicalHeaders = signedHeaderNames
      .map((name) => {
        const value = headers[Object.keys(headers).find((k) => k.toLowerCase() === name)!];
        return `${name}:${value.trim()}`;
      })
      .join("\n") + "\n";

    const signedHeaders = signedHeaderNames.join(";");

    // Canonical query string (sorted)
    const queryParams = Array.from(url.searchParams.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .join("&");

    const canonicalPath = url.pathname;

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

    const signingKey = await deriveSigningKey(this.config.secretAccessKey, date, region, service);
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
        "Host": new URL(url).host,
      };
      const authorization = await this.buildAuthorization(
        "HEAD", new URL(url), headers, payloadHash, datetime, date,
      );
      headers["Authorization"] = authorization;
      delete headers["Host"];

      const response = await fetch(url, { method: "HEAD", headers });
      if (response.ok || response.status === 403) {
        // 403 = bucket exists but no ListBucket permission — credentials are valid
        return { ok: true };
      }
      return { ok: false, error: `HTTP ${response.status}: ${response.statusText}` };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
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

async function hmacSha256(key: BufferSource, data: string): Promise<ArrayBuffer> {
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
  const kDate = await hmacSha256(new TextEncoder().encode(`AWS4${secretKey}`), date);
  const kRegion = await hmacSha256(kDate, region);
  const kService = await hmacSha256(kRegion, service);
  return hmacSha256(kService, "aws4_request");
}

function isoDatetime(d: Date): string {
  return d.toISOString().replace(/[-:]/g, "").slice(0, 15) + "Z";
}
