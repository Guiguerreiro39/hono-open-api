import type { S3ClientConfig } from "@aws-sdk/client-s3";
import type {
  StorageBody,
  StorageGetOptions,
  StorageObjectMetadata,
  StoragePort,
  StoragePutOptions,
  StorageSignedGetOptions,
  StorageSignedPutOptions,
} from "@/core/ports/storage";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

import {
  assertValidSignedPutOptions,
  assertValidStorageKey,
  resolvePresignExpiresIn,
  uint8ArrayToStream,
  validateStorageRange,
} from "./key";

const DEFAULT_EXPIRES_IN_SECONDS = 900;
const MULTIPART_PART_SIZE_BYTES = 5 * 1024 * 1024;
const MULTIPART_QUEUE_SIZE = 4;

export interface S3StorageAdapterOptions {
  bucket: string;
  region: string;
  endpoint?: string;
  publicEndpoint?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  forcePathStyle?: boolean;
  defaultExpiresInSeconds?: number;
}

function getS3ErrorInfo(err: unknown): { name?: string; status?: number } {
  if (typeof err !== "object" || err === null) {
    return {};
  }
  const name = "name" in err && typeof err.name === "string" ? err.name : undefined;
  const metadata = "$metadata" in err && typeof err.$metadata === "object" && err.$metadata !== null
    ? err.$metadata
    : undefined;
  const status = metadata && "httpStatusCode" in metadata && typeof metadata.httpStatusCode === "number"
    ? metadata.httpStatusCode
    : undefined;
  return { name, status };
}

function isS3NotFoundError(err: unknown): boolean {
  const { name, status } = getS3ErrorInfo(err);
  return status === 404 || name === "NotFound" || name === "NoSuchKey";
}

function isS3InvalidRangeError(err: unknown): boolean {
  const { name, status } = getS3ErrorInfo(err);
  return status === 416 || name === "InvalidRange";
}

export class S3StorageAdapter implements StoragePort {
  readonly client: S3Client;
  private readonly presignClient: S3Client;
  private readonly bucket: string;
  private readonly publicEndpoint?: string;
  private readonly defaultExpiresInSeconds: number;

  constructor(options: S3StorageAdapterOptions) {
    this.bucket = options.bucket;
    this.publicEndpoint = options.publicEndpoint;
    this.defaultExpiresInSeconds = options.defaultExpiresInSeconds ?? DEFAULT_EXPIRES_IN_SECONDS;

    const credentials = options.accessKeyId && options.secretAccessKey
      ? {
          accessKeyId: options.accessKeyId,
          secretAccessKey: options.secretAccessKey,
        }
      : undefined;

    const forcePathStyle = options.forcePathStyle ?? false;

    const baseConfig: S3ClientConfig = {
      region: options.region,
      ...(options.endpoint ? { endpoint: options.endpoint } : {}),
      forcePathStyle,
      ...(credentials ? { credentials } : {}),
      requestChecksumCalculation: "WHEN_REQUIRED",
      responseChecksumValidation: "WHEN_REQUIRED",
    };

    this.client = new S3Client(baseConfig);
    // When using path-style URLs with a distinct public endpoint (e.g. Docker internal s3:9000 vs localhost:9000),
    // sign directly against the public endpoint so the signed Host header matches the external client request.
    this.presignClient = options.publicEndpoint && forcePathStyle
      ? new S3Client({
          ...baseConfig,
          endpoint: options.publicEndpoint,
        })
      : this.client;
  }

  private rewritePresignedOrigin(signedUrl: string): string {
    if (!this.publicEndpoint) {
      return signedUrl;
    }
    const parsed = new URL(signedUrl);
    const publicUrl = new URL(this.publicEndpoint);
    parsed.protocol = publicUrl.protocol;
    parsed.hostname = publicUrl.hostname;
    parsed.port = publicUrl.port;
    return parsed.toString();
  }

  async put(
    key: string,
    body: StorageBody,
    opts?: StoragePutOptions,
  ): Promise<void> {
    assertValidStorageKey(key);

    if (body instanceof Uint8Array) {
      await this.client.send(new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: opts?.contentType,
        ContentLength: opts?.contentLength ?? body.byteLength,
      }));
      return;
    }

    const upload = new Upload({
      client: this.client,
      params: {
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: opts?.contentType,
      },
      partSize: MULTIPART_PART_SIZE_BYTES,
      queueSize: MULTIPART_QUEUE_SIZE,
    });
    await upload.done();
  }

  async get(
    key: string,
    opts?: StorageGetOptions,
  ): Promise<ReadableStream<Uint8Array> | null> {
    assertValidStorageKey(key);
    if (opts?.range) {
      validateStorageRange(opts.range);
    }

    try {
      const res = await this.client.send(new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
        ...(opts?.range ? { Range: `bytes=${opts.range.start}-${opts.range.end}` } : {}),
      }));
      if (!res.Body) {
        return uint8ArrayToStream(new Uint8Array(0));
      }
      return res.Body.transformToWebStream() as ReadableStream<Uint8Array>;
    }
    catch (err) {
      if (isS3NotFoundError(err)) {
        return null;
      }
      if (opts?.range && isS3InvalidRangeError(err)) {
        return uint8ArrayToStream(new Uint8Array(0));
      }
      throw err;
    }
  }

  async head(key: string): Promise<StorageObjectMetadata | null> {
    assertValidStorageKey(key);
    try {
      const res = await this.client.send(new HeadObjectCommand({
        Bucket: this.bucket,
        Key: key,
      }));
      return {
        size: res.ContentLength ?? 0,
        contentType: res.ContentType,
        etag: res.ETag,
        lastModified: res.LastModified,
      };
    }
    catch (err) {
      if (isS3NotFoundError(err)) {
        return null;
      }
      throw err;
    }
  }

  async delete(key: string): Promise<void> {
    assertValidStorageKey(key);
    await this.client.send(new DeleteObjectCommand({
      Bucket: this.bucket,
      Key: key,
    }));
  }

  async getSignedPutUrl(key: string, opts: StorageSignedPutOptions): Promise<string> {
    assertValidStorageKey(key);
    assertValidSignedPutOptions(opts);
    const expiresIn = resolvePresignExpiresIn(opts.expiresInSeconds, this.defaultExpiresInSeconds);
    const signedUrl = await getSignedUrl(
      this.presignClient,
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        ContentType: opts.contentType,
        ContentLength: opts.contentLength,
      }),
      { expiresIn },
    );
    return this.rewritePresignedOrigin(signedUrl);
  }

  async getSignedGetUrl(key: string, opts?: StorageSignedGetOptions): Promise<string> {
    assertValidStorageKey(key);
    const expiresIn = resolvePresignExpiresIn(opts?.expiresInSeconds, this.defaultExpiresInSeconds);
    const signedUrl = await getSignedUrl(
      this.presignClient,
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
        ...(opts?.responseContentDisposition ? { ResponseContentDisposition: opts.responseContentDisposition } : {}),
        ...(opts?.responseContentType ? { ResponseContentType: opts.responseContentType } : {}),
      }),
      { expiresIn },
    );
    return this.rewritePresignedOrigin(signedUrl);
  }

  async close(): Promise<void> {
    this.client.destroy();
    if (this.presignClient !== this.client) {
      this.presignClient.destroy();
    }
  }
}

export function createS3StorageAdapter(options: S3StorageAdapterOptions): S3StorageAdapter {
  return new S3StorageAdapter(options);
}
