import type { StoragePort } from "@/core/ports/storage";
import { describe, expect, it } from "vitest";

import { parseEnv } from "@/env";
import { createStorageAdapter } from "@/infra/storage";

import { defineStorageContract } from "../contracts/storage.contract";
import { createTestApp } from "../helpers/test-app";
import { getIntegrationEnv } from "./env";

function createCleanupTrackingStorage(
  inner: StoragePort,
  trackedKeys: Set<string>,
): StoragePort {
  return {
    put(key, body, opts) {
      trackedKeys.add(key);
      return inner.put(key, body, opts);
    },
    get(key, opts) {
      return inner.get(key, opts);
    },
    head(key) {
      return inner.head(key);
    },
    delete(key) {
      trackedKeys.delete(key);
      return inner.delete(key);
    },
    getSignedPutUrl(key, opts) {
      trackedKeys.add(key);
      return inner.getSignedPutUrl(key, opts);
    },
    getSignedGetUrl(key, opts) {
      return inner.getSignedGetUrl(key, opts);
    },
  };
}

defineStorageContract("S3StorageAdapter (RustFS integration)", () => {
  const integrationEnv = getIntegrationEnv();
  const env = parseEnv({
    NODE_ENV: "test",
    ...integrationEnv,
  });
  const { port, close } = createStorageAdapter(env);
  const trackedKeys = new Set<string>();

  return {
    storage: createCleanupTrackingStorage(port, trackedKeys),
    transfer: (url, init) => fetch(url, init),
    cleanup: async () => {
      await Promise.allSettled([...trackedKeys].map(key => port.delete(key)));
      await close();
    },
  };
});

describe("s3StorageAdapter HTTP and S3_PUBLIC_ENDPOINT integration", () => {
  it("returns 404 on /_storage/* and signs valid presigned URLs against S3_PUBLIC_ENDPOINT", async () => {
    const integrationEnv = getIntegrationEnv({
      S3_ENDPOINT: "http://127.0.0.1:9000",
      S3_PUBLIC_ENDPOINT: "http://localhost:9000",
      S3_FORCE_PATH_STYLE: "true",
    });

    const ctx = await createTestApp(integrationEnv);
    const key = `integration/${crypto.randomUUID()}/public-endpoint.txt`;
    const payload = new TextEncoder().encode("rustfs-public-endpoint-roundtrip");

    try {
      const storageRouteRes = await ctx.app.request("/_storage/object?key=ignored");
      expect(storageRouteRes.status).toBe(404);

      const putUrl = await ctx.container.storage.getSignedPutUrl(key, {
        contentType: "text/plain",
        contentLength: payload.byteLength,
        expiresInSeconds: 60,
      });
      expect(new URL(putUrl).origin).toBe("http://localhost:9000");

      const putRes = await fetch(putUrl, {
        method: "PUT",
        headers: { "Content-Type": "text/plain" },
        body: payload,
      });
      expect(putRes.ok).toBe(true);
      await putRes.body?.cancel();

      const getUrl = await ctx.container.storage.getSignedGetUrl(key, {
        expiresInSeconds: 60,
      });
      expect(new URL(getUrl).origin).toBe("http://localhost:9000");

      const getRes = await fetch(getUrl);
      expect(getRes.status).toBe(200);
      expect(new Uint8Array(await getRes.arrayBuffer())).toEqual(payload);
    }
    finally {
      await ctx.container.storage.delete(key).catch(() => {});
      await ctx.cleanup();
    }
  });
});
