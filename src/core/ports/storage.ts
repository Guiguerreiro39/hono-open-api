export type StorageBody = Uint8Array | ReadableStream<Uint8Array>;

export interface StorageRange {
  start: number;
  end: number;
}

export interface StoragePutOptions {
  contentType?: string;
  contentLength?: number;
}

export interface StorageGetOptions {
  range?: StorageRange;
}

export interface StorageObjectMetadata {
  size: number;
  contentType?: string;
  etag?: string;
  lastModified?: Date;
}

export interface StorageSignedPutOptions {
  contentType: string;
  contentLength: number;
  expiresInSeconds?: number;
}

export interface StorageSignedGetOptions {
  expiresInSeconds?: number;
  responseContentType?: string;
  responseContentDisposition?: string;
}

export interface StorageSignedRequestContext {
  requestId?: string;
}

export interface StoragePort {
  put: (key: string, body: StorageBody, opts?: StoragePutOptions) => Promise<void>;
  get: (key: string, opts?: StorageGetOptions) => Promise<ReadableStream<Uint8Array> | null>;
  head: (key: string) => Promise<StorageObjectMetadata | null>;
  delete: (key: string) => Promise<void>;
  getSignedPutUrl: (key: string, opts: StorageSignedPutOptions) => Promise<string>;
  getSignedGetUrl: (key: string, opts?: StorageSignedGetOptions) => Promise<string>;
  handleSignedRequest?: (req: Request, context?: StorageSignedRequestContext) => Promise<Response>;
}
