import type {
  StorageBody,
  StorageGetOptions,
  StorageObjectMetadata,
  StoragePort,
  StoragePutOptions,
  StorageSignedGetOptions,
  StorageSignedPutOptions,
  StorageSignedRequestContext,
} from "@/core/ports/storage";
import { createReadStream } from "node:fs";
import { mkdir, open, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";

import { BadRequestError } from "@/core/errors";

import { assertValidStorageKey, uint8ArrayToStream, validateStorageRange } from "./key";
import { createSignedStorageHandlers } from "./signed-url";

export interface LocalStorageAdapterOptions {
  rootDir: string;
  signingSecret?: string;
  baseUrl?: string;
  defaultExpiresInSeconds?: number;
  maxPresignBytes?: number;
}

function isEnoent(err: unknown): boolean {
  return typeof err === "object"
    && err !== null
    && "code" in err
    && err.code === "ENOENT";
}

async function writeStreamToFile(
  filePath: string,
  stream: ReadableStream<Uint8Array>,
): Promise<void> {
  const handle = await open(filePath, "w");
  const reader = stream.getReader();

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      await handle.write(value);
    }
  }
  catch (err) {
    await reader.cancel(err).catch(() => {});
    throw err;
  }
  finally {
    reader.releaseLock();
    await handle.close();
  }
}

export class LocalStorageAdapter implements StoragePort {
  readonly rootDir: string;
  private readonly signedHandlers: ReturnType<typeof createSignedStorageHandlers>;

  constructor(options: LocalStorageAdapterOptions) {
    this.rootDir = path.resolve(options.rootDir);
    this.signedHandlers = createSignedStorageHandlers({
      storage: this,
      signingSecret: options.signingSecret ?? "local-storage-secret",
      baseUrl: options.baseUrl,
      defaultExpiresInSeconds: options.defaultExpiresInSeconds,
      maxPresignBytes: options.maxPresignBytes,
    });
  }

  private resolveContainedPath(key: string): string {
    assertValidStorageKey(key);
    const resolved = path.resolve(this.rootDir, key);
    const relative = path.relative(this.rootDir, resolved);

    if (
      relative === ""
      || relative.startsWith("..")
      || path.isAbsolute(relative)
    ) {
      throw new BadRequestError("Storage key escapes local storage root");
    }

    return resolved;
  }

  async put(
    key: string,
    body: StorageBody,
    _opts?: StoragePutOptions,
  ): Promise<void> {
    const targetPath = this.resolveContainedPath(key);
    const dirPath = path.dirname(targetPath);
    await mkdir(dirPath, { recursive: true });

    const tmpPath = path.join(
      dirPath,
      `.${path.basename(targetPath)}.tmp-${crypto.randomUUID()}`,
    );

    try {
      if (body instanceof Uint8Array) {
        await writeFile(tmpPath, body);
      }
      else {
        await writeStreamToFile(tmpPath, body);
      }
      await rename(tmpPath, targetPath);
    }
    catch (err) {
      await rm(tmpPath, { force: true }).catch(() => {});
      throw err;
    }
  }

  async get(
    key: string,
    opts?: StorageGetOptions,
  ): Promise<ReadableStream<Uint8Array> | null> {
    const targetPath = this.resolveContainedPath(key);
    if (opts?.range) {
      validateStorageRange(opts.range);
    }

    let fileStats;
    try {
      fileStats = await stat(targetPath);
    }
    catch (err) {
      if (isEnoent(err)) {
        return null;
      }
      throw err;
    }

    if (!fileStats.isFile()) {
      return null;
    }

    if (opts?.range) {
      if (fileStats.size === 0 || opts.range.start >= fileStats.size) {
        return uint8ArrayToStream(new Uint8Array(0));
      }
      const end = Math.min(opts.range.end, fileStats.size - 1);
      const nodeStream = createReadStream(targetPath, {
        start: opts.range.start,
        end,
      });
      return Readable.toWeb(nodeStream) as ReadableStream<Uint8Array>;
    }

    const nodeStream = createReadStream(targetPath);
    return Readable.toWeb(nodeStream) as ReadableStream<Uint8Array>;
  }

  async head(key: string): Promise<StorageObjectMetadata | null> {
    const targetPath = this.resolveContainedPath(key);
    try {
      const fileStats = await stat(targetPath);
      if (!fileStats.isFile()) {
        return null;
      }
      return {
        size: fileStats.size,
        lastModified: fileStats.mtime,
      };
    }
    catch (err) {
      if (isEnoent(err)) {
        return null;
      }
      throw err;
    }
  }

  async delete(key: string): Promise<void> {
    const targetPath = this.resolveContainedPath(key);
    try {
      await unlink(targetPath);
    }
    catch (err) {
      if (isEnoent(err)) {
        return;
      }
      throw err;
    }
  }

  getSignedPutUrl(key: string, opts: StorageSignedPutOptions): Promise<string> {
    return this.signedHandlers.getSignedPutUrl(key, opts);
  }

  getSignedGetUrl(key: string, opts?: StorageSignedGetOptions): Promise<string> {
    return this.signedHandlers.getSignedGetUrl(key, opts);
  }

  handleSignedRequest(req: Request, context?: StorageSignedRequestContext): Promise<Response> {
    return this.signedHandlers.handleSignedRequest(req, context);
  }
}

export function createLocalStorageAdapter(options: LocalStorageAdapterOptions): LocalStorageAdapter {
  return new LocalStorageAdapter(options);
}
