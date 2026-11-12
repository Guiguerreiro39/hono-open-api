import type { StoragePort } from "@/core/ports/storage";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { parseEnv } from "@/env";
import { createStorageAdapter } from "@/infra/storage";
import { createLocalStorageAdapter, LocalStorageAdapter } from "@/infra/storage/local";
import { MemoryStorageAdapter } from "@/infra/storage/memory";
import { createS3StorageAdapter, S3StorageAdapter } from "@/infra/storage/s3";

import { defineStorageContract } from "../../../tests/contracts/storage.contract";
import { createTestApp } from "../../../tests/helpers/test-app";

defineStorageContract("MemoryStorageAdapter (via createTestApp /_storage/*)", async () => {
  const ctx = await createTestApp({ STORAGE_DRIVER: "memory" });

  return {
    storage: ctx.container.storage,
    transfer: (url, init) => ctx.app.request(url, init),
    cleanup: ctx.cleanup,
  };
});

defineStorageContract("LocalStorageAdapter (via createTestApp /_storage/*)", async () => {
  const ctx = await createTestApp({ STORAGE_DRIVER: "local" });

  return {
    storage: ctx.container.storage,
    transfer: (url, init) => ctx.app.request(url, init),
    cleanup: ctx.cleanup,
  };
});

describe("localStorageAdapter containment and atomicity", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop()!;
      await rm(dir, { recursive: true, force: true });
    }
  });

  async function createIsolatedLocal() {
    const parent = await mkdtemp(path.join(os.tmpdir(), "hono-local-parent-"));
    tempDirs.push(parent);
    const rootDir = path.join(parent, "bucket");
    const storage = createLocalStorageAdapter({
      rootDir,
      signingSecret: "test-signing-secret",
      baseUrl: "http://localhost:9999",
    });
    return { parent, rootDir, storage };
  }

  it("rejects path traversal outside rootDir across all StoragePort methods", async () => {
    const { parent, storage } = await createIsolatedLocal();
    const evilKeys = [
      "",
      "../escape.txt",
      "nested/../../escape.txt",
      "/etc/passwd",
      "..",
      ".",
      "dir/./file.txt",
      "bad\0key.txt",
      "foo\\..\\bar.txt",
    ];

    for (const badKey of evilKeys) {
      await expect(storage.put(badKey, new Uint8Array([1, 2, 3]))).rejects.toThrow();
      await expect(storage.get(badKey)).rejects.toThrow();
      await expect(storage.head(badKey)).rejects.toThrow();
      await expect(storage.delete(badKey)).rejects.toThrow();
      await expect(storage.getSignedPutUrl(badKey, { contentType: "text/plain", contentLength: 3 })).rejects.toThrow();
      await expect(storage.getSignedGetUrl(badKey)).rejects.toThrow();
    }

    const parentEntries = await readdir(parent);
    expect(parentEntries).not.toContain("escape.txt");
  });

  it("writes atomically via temp file plus rename without corrupting existing blobs on failed streams", async () => {
    const { rootDir, storage } = await createIsolatedLocal();
    const key = "files/user-1/doc.txt";
    const original = new TextEncoder().encode("original-intact-content");

    await storage.put(key, original, { contentType: "text/plain" });

    const failingStream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("partial-corrupt"));
        controller.error(new Error("simulated stream abort"));
      },
    });

    await expect(storage.put(key, failingStream)).rejects.toThrow("simulated stream abort");

    const persisted = await readFile(path.join(rootDir, "files", "user-1", "doc.txt"));
    expect(new Uint8Array(persisted)).toEqual(original);

    const dirEntries = await readdir(path.join(rootDir, "files", "user-1"));
    expect(dirEntries).toEqual(["doc.txt"]);
  });
});

async function collectTsFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await collectTsFiles(full));
    }
    else if (entry.name.endsWith(".ts")) {
      files.push(full);
    }
  }
  return files;
}

describe("s3StorageAdapter and storage factory", () => {
  it("keeps src/core/ completely free of @aws-sdk/* imports", async () => {
    const coreDir = path.resolve(__dirname, "../../core");
    const coreFiles = await collectTsFiles(coreDir);
    expect(coreFiles.length).toBeGreaterThan(0);

    for (const file of coreFiles) {
      const content = await readFile(file, "utf8");
      expect(content).not.toContain("@aws-sdk/");
    }
  });

  it("configures WHEN_REQUIRED checksums, allows IAM/IRSA default credentials, and rewrites presigned origins to S3_PUBLIC_ENDPOINT", async () => {
    const iamS3 = createS3StorageAdapter({
      bucket: "iam-bucket",
      region: "us-east-1",
    });
    const iamPort: StoragePort = iamS3;
    expect(iamPort.handleSignedRequest).toBeUndefined();
    expect(await iamS3.client.config.requestChecksumCalculation()).toBe("WHEN_REQUIRED");
    expect(await iamS3.client.config.responseChecksumValidation()).toBe("WHEN_REQUIRED");
    await iamS3.close();

    for (const forcePathStyle of [true, false]) {
      const s3 = createS3StorageAdapter({
        bucket: "app-uploads",
        region: "us-east-1",
        endpoint: "http://s3:9000",
        publicEndpoint: "https://uploads.example.com",
        accessKeyId: "test-key",
        secretAccessKey: "test-secret",
        forcePathStyle,
        defaultExpiresInSeconds: 600,
      });

      const putUrl = await s3.getSignedPutUrl("files/user-1/pic.png", {
        contentType: "image/png",
        contentLength: 1024,
      });
      const parsedPut = new URL(putUrl);
      expect(parsedPut.origin).toBe("https://uploads.example.com");
      expect(parsedPut.searchParams.get("X-Amz-Expires")).toBe("600");
      expect(parsedPut.searchParams.get("X-Amz-SignedHeaders")).not.toContain("x-amz-checksum-crc32");

      const getUrl = await s3.getSignedGetUrl("files/user-1/pic.png");
      const parsedGet = new URL(getUrl);
      expect(parsedGet.origin).toBe("https://uploads.example.com");
      expect(parsedGet.searchParams.get("X-Amz-Expires")).toBe("600");
      expect(parsedGet.searchParams.has("x-amz-checksum-mode")).toBe(false);

      await s3.close();
    }
  });

  it("selects Memory, Local, or S3 adapter based on env.STORAGE_DRIVER", async () => {
    const memory = createStorageAdapter(parseEnv({ NODE_ENV: "test", STORAGE_DRIVER: "memory" }));
    expect(memory.port).toBeInstanceOf(MemoryStorageAdapter);
    await memory.close();

    const local = createStorageAdapter(parseEnv({ NODE_ENV: "test", STORAGE_DRIVER: "local" }));
    expect(local.port).toBeInstanceOf(LocalStorageAdapter);
    await local.close();

    const s3 = createStorageAdapter(parseEnv({
      NODE_ENV: "test",
      STORAGE_DRIVER: "s3",
      S3_BUCKET: "factory-bucket",
    }));
    expect(s3.port).toBeInstanceOf(S3StorageAdapter);
    await s3.close();
  });

  it("allocates and cleans up os.tmpdir() storage directories in createTestApp", async () => {
    const ctx = await createTestApp({ STORAGE_DRIVER: "local" });
    const storageDir = ctx.env.STORAGE_LOCAL_DIR;
    expect(path.resolve(storageDir).startsWith(path.resolve(os.tmpdir()))).toBe(true);

    await ctx.container.storage.put("cleanup/check.txt", new TextEncoder().encode("bye"));
    expect(existsSync(path.join(storageDir, "cleanup", "check.txt"))).toBe(true);

    await ctx.cleanup();
    expect(existsSync(storageDir)).toBe(false);
  });
});
