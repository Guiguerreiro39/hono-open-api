import type { StorageBody, StorageRange, StorageSignedPutOptions } from "@/core/ports/storage";
import { BadRequestError, PayloadTooLargeError } from "@/core/errors";

export function assertValidStorageKey(key: string): string {
  if (
    key.length === 0
    || key.includes("\0")
    || key.startsWith("/")
    || key.includes("\\")
  ) {
    throw new BadRequestError("Invalid storage key");
  }

  const segments = key.split("/");
  for (const segment of segments) {
    if (segment === "" || segment === "." || segment === "..") {
      throw new BadRequestError("Invalid storage key");
    }
  }

  return key;
}

export function validateStorageRange(range: StorageRange): StorageRange {
  if (
    !Number.isInteger(range.start)
    || !Number.isInteger(range.end)
    || range.start < 0
    || range.end < range.start
  ) {
    throw new BadRequestError("Invalid byte range");
  }
  return range;
}

export function resolvePresignExpiresIn(
  expiresInSeconds: number | undefined,
  defaultExpiresInSeconds: number,
): number {
  const resolved = expiresInSeconds ?? defaultExpiresInSeconds;
  if (!Number.isFinite(resolved) || resolved < 0) {
    throw new BadRequestError("Invalid presign expiration");
  }
  return resolved;
}

export function assertValidSignedPutOptions(opts: StorageSignedPutOptions): void {
  if (!Number.isSafeInteger(opts.contentLength) || opts.contentLength < 0) {
    throw new BadRequestError("Invalid content length");
  }
}

export function uint8ArrayToStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      if (bytes.byteLength > 0) {
        controller.enqueue(new Uint8Array(bytes));
      }
      controller.close();
    },
  });
}

export async function bodyToUint8Array(
  body: StorageBody,
  maxBytes?: number,
): Promise<Uint8Array> {
  if (body instanceof Uint8Array) {
    if (maxBytes !== undefined && body.byteLength > maxBytes) {
      throw new PayloadTooLargeError("Storage object exceeds maximum allowed size");
    }
    return new Uint8Array(body);
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      total += value.byteLength;
      if (maxBytes !== undefined && total > maxBytes) {
        await reader.cancel();
        throw new PayloadTooLargeError("Storage object exceeds maximum allowed size");
      }
      chunks.push(value);
    }
  }
  finally {
    reader.releaseLock();
  }

  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}
