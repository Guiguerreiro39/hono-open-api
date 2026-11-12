import type { StorageObjectMetadata, StoragePort } from "@/core/ports/storage";

import {
  assertValidStorageKey,
  bodyToUint8Array,
  uint8ArrayToStream,
  validateStorageRange,
} from "./key";
import { createSignedStorageHandlers } from "./signed-url";

export interface MemoryStorageAdapterOptions {
  signingSecret?: string;
  baseUrl?: string;
  defaultExpiresInSeconds?: number;
  maxPresignBytes?: number;
}

interface StoredEntry {
  data: Uint8Array;
  contentType?: string;
  lastModified: Date;
}

export class MemoryStorageAdapter implements StoragePort {
  private readonly blobs = new Map<string, StoredEntry>();
  private readonly signedHandlers: ReturnType<typeof createSignedStorageHandlers>;

  constructor(options: MemoryStorageAdapterOptions = {}) {
    this.signedHandlers = createSignedStorageHandlers({
      storage: this,
      signingSecret: options.signingSecret ?? "memory-storage-secret",
      baseUrl: options.baseUrl,
      defaultExpiresInSeconds: options.defaultExpiresInSeconds,
      maxPresignBytes: options.maxPresignBytes,
    });
  }

  async put(
    key: string,
    body: Uint8Array | ReadableStream<Uint8Array>,
    opts?: { contentType?: string; contentLength?: number },
  ): Promise<void> {
    assertValidStorageKey(key);
    const data = await bodyToUint8Array(body);
    this.blobs.set(key, {
      data,
      contentType: opts?.contentType,
      lastModified: new Date(),
    });
  }

  async get(
    key: string,
    opts?: { range?: { start: number; end: number } },
  ): Promise<ReadableStream<Uint8Array> | null> {
    assertValidStorageKey(key);
    if (opts?.range) {
      validateStorageRange(opts.range);
    }

    const entry = this.blobs.get(key);
    if (!entry) {
      return null;
    }

    const slice = opts?.range
      ? entry.data.subarray(opts.range.start, opts.range.end + 1)
      : entry.data;

    return uint8ArrayToStream(slice);
  }

  async head(key: string): Promise<StorageObjectMetadata | null> {
    assertValidStorageKey(key);
    const entry = this.blobs.get(key);
    if (!entry) {
      return null;
    }

    return {
      size: entry.data.byteLength,
      contentType: entry.contentType,
      lastModified: entry.lastModified,
    };
  }

  async delete(key: string): Promise<void> {
    assertValidStorageKey(key);
    this.blobs.delete(key);
  }

  getSignedPutUrl(
    key: string,
    opts: { contentType: string; contentLength: number; expiresInSeconds?: number },
  ): Promise<string> {
    return this.signedHandlers.getSignedPutUrl(key, opts);
  }

  getSignedGetUrl(
    key: string,
    opts?: { expiresInSeconds?: number; responseContentType?: string; responseContentDisposition?: string },
  ): Promise<string> {
    return this.signedHandlers.getSignedGetUrl(key, opts);
  }

  handleSignedRequest(req: Request, context?: { requestId?: string }): Promise<Response> {
    return this.signedHandlers.handleSignedRequest(req, context);
  }
}

export function createMemoryStorageAdapter(options?: MemoryStorageAdapterOptions): MemoryStorageAdapter {
  return new MemoryStorageAdapter(options);
}
