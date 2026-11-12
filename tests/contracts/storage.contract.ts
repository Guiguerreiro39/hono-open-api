import type { StoragePort } from "@/core/ports/storage";
import { afterEach, describe, expect, it, vi } from "vitest";

export interface StorageContractTarget {
  storage: StoragePort;
  transfer: (url: string, init?: RequestInit) => Response | Promise<Response>;
  cleanup?: () => Promise<void>;
}

async function readStreamBytes(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    chunks.push(value);
    total += value.byteLength;
  }

  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

function toStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  const mid = Math.max(1, Math.floor(bytes.byteLength / 2));
  return new ReadableStream<Uint8Array>({
    start(controller) {
      if (bytes.byteLength > 0) {
        controller.enqueue(bytes.subarray(0, mid));
        if (mid < bytes.byteLength) {
          controller.enqueue(bytes.subarray(mid));
        }
      }
      controller.close();
    },
  });
}

function tamperSignature(signedUrl: string): string {
  const parsed = new URL(signedUrl);
  for (const key of ["sig", "X-Amz-Signature"]) {
    const current = parsed.searchParams.get(key);
    if (current) {
      const replacement = (current[0] === "a" ? "b" : "a") + current.slice(1);
      parsed.searchParams.set(key, replacement);
      return parsed.toString();
    }
  }
  throw new Error(`Expected signature parameter in URL: ${signedUrl}`);
}

export function defineStorageContract(
  name: string,
  createTarget: () => Promise<StorageContractTarget> | StorageContractTarget,
) {
  describe(`${name} (StoragePort contract)`, () => {
    const cleanups: Array<() => Promise<void>> = [];

    afterEach(async () => {
      vi.useRealTimers();
      while (cleanups.length > 0) {
        await cleanups.pop()?.();
      }
    });

    async function setup(): Promise<StorageContractTarget> {
      const target = await createTarget();
      if (target.cleanup) {
        cleanups.push(target.cleanup);
      }
      return target;
    }

    it("puts, heads, gets, and overwrites Uint8Array and ReadableStream objects, returning null when missing", async () => {
      const { storage } = await setup();
      const missingKey = `contract/${crypto.randomUUID()}/missing.txt`;

      expect(await storage.head(missingKey)).toBeNull();
      expect(await storage.get(missingKey)).toBeNull();

      const key = `contract/${crypto.randomUUID()}/hello.txt`;
      const initialBytes = new TextEncoder().encode("hello storage world");
      await storage.put(key, initialBytes, {
        contentType: "text/plain",
        contentLength: initialBytes.byteLength,
      });

      const meta = await storage.head(key);
      expect(meta).not.toBeNull();
      expect(meta?.size).toBe(initialBytes.byteLength);

      const stream = await storage.get(key);
      expect(stream).not.toBeNull();
      expect(await readStreamBytes(stream!)).toEqual(initialBytes);

      const replacementBytes = new TextEncoder().encode("streamed-replacement-payload");
      await storage.put(key, toStream(replacementBytes), {
        contentType: "application/octet-stream",
      });

      const updatedMeta = await storage.head(key);
      expect(updatedMeta?.size).toBe(replacementBytes.byteLength);
      const updatedStream = await storage.get(key);
      expect(updatedStream).not.toBeNull();
      expect(await readStreamBytes(updatedStream!)).toEqual(replacementBytes);
    });

    it("supports inclusive byte-range reads, clamps past EOF, handles empty objects, and rejects invalid ranges", async () => {
      const { storage } = await setup();
      const key = `contract/${crypto.randomUUID()}/range.bin`;
      const payload = new TextEncoder().encode("0123456789abcdef");

      await storage.put(key, payload, { contentType: "application/octet-stream" });

      const firstFour = await storage.get(key, { range: { start: 0, end: 3 } });
      expect(new TextDecoder().decode(await readStreamBytes(firstFour!))).toBe("0123");

      const singleByte = await storage.get(key, { range: { start: 5, end: 5 } });
      expect(new TextDecoder().decode(await readStreamBytes(singleByte!))).toBe("5");

      const clampedTail = await storage.get(key, { range: { start: 12, end: 4095 } });
      expect(new TextDecoder().decode(await readStreamBytes(clampedTail!))).toBe("cdef");

      const pastEof = await storage.get(key, { range: { start: 32, end: 64 } });
      expect(pastEof).not.toBeNull();
      expect((await readStreamBytes(pastEof!)).byteLength).toBe(0);

      expect(await storage.get(`contract/${crypto.randomUUID()}/missing`, { range: { start: 0, end: 3 } })).toBeNull();

      const emptyKey = `contract/${crypto.randomUUID()}/empty.bin`;
      await storage.put(emptyKey, new Uint8Array(0), { contentType: "application/octet-stream" });
      expect((await storage.head(emptyKey))?.size).toBe(0);
      const emptyRange = await storage.get(emptyKey, { range: { start: 0, end: 4095 } });
      expect(emptyRange).not.toBeNull();
      expect((await readStreamBytes(emptyRange!)).byteLength).toBe(0);

      await expect(storage.get(key, { range: { start: -1, end: 4 } })).rejects.toThrow();
      await expect(storage.get(key, { range: { start: 8, end: 4 } })).rejects.toThrow();
    });

    it("deletes objects idempotently", async () => {
      const { storage } = await setup();
      const key = `contract/${crypto.randomUUID()}/delete-me.txt`;

      await expect(storage.delete(key)).resolves.toBeUndefined();

      await storage.put(key, new TextEncoder().encode("temporary"), { contentType: "text/plain" });
      expect(await storage.head(key)).not.toBeNull();

      await storage.delete(key);
      expect(await storage.head(key)).toBeNull();
      expect(await storage.get(key)).toBeNull();

      await expect(storage.delete(key)).resolves.toBeUndefined();
    });

    it("supports presigned PUT and GET round-trips and rejects tampered, mismatched-length, and expired URLs", async () => {
      const { storage, transfer } = await setup();
      const key = `contract/${crypto.randomUUID()}/presigned.bin`;
      const payload = new TextEncoder().encode("presigned-payload-bytes-1234567890");

      const putUrl = await storage.getSignedPutUrl(key, {
        contentType: "application/octet-stream",
        contentLength: payload.byteLength,
        expiresInSeconds: 60,
      });

      const tamperedPutRes = await transfer(tamperSignature(putUrl), {
        method: "PUT",
        headers: { "Content-Type": "application/octet-stream" },
        body: payload,
      });
      expect(tamperedPutRes.status).toBe(403);
      await tamperedPutRes.body?.cancel();
      expect(await storage.head(key)).toBeNull();

      const wrongLenRes = await transfer(putUrl, {
        method: "PUT",
        headers: { "Content-Type": "application/octet-stream" },
        body: payload.subarray(0, 5),
      });
      expect(wrongLenRes.ok).toBe(false);
      expect(wrongLenRes.status).toBeGreaterThanOrEqual(400);
      await wrongLenRes.body?.cancel();

      const putRes = await transfer(putUrl, {
        method: "PUT",
        headers: { "Content-Type": "application/octet-stream" },
        body: payload,
      });
      expect(putRes.ok).toBe(true);
      await putRes.body?.cancel();

      const meta = await storage.head(key);
      expect(meta?.size).toBe(payload.byteLength);

      const getUrl = await storage.getSignedGetUrl(key, { expiresInSeconds: 60 });
      const getRes = await transfer(getUrl, { method: "GET" });
      expect(getRes.status).toBe(200);
      expect(new Uint8Array(await getRes.arrayBuffer())).toEqual(payload);

      const tamperedGetRes = await transfer(tamperSignature(getUrl), { method: "GET" });
      expect(tamperedGetRes.status).toBe(403);
      await tamperedGetRes.body?.cancel();

      const missingGetUrl = await storage.getSignedGetUrl(`contract/${crypto.randomUUID()}/absent.bin`, {
        expiresInSeconds: 60,
      });
      const missingGetRes = await transfer(missingGetUrl, { method: "GET" });
      expect(missingGetRes.status).toBe(404);
      await missingGetRes.body?.cancel();

      const pastNow = Date.now() - 120_000;
      let expiredPutUrl: string;
      let expiredGetUrl: string;
      vi.useFakeTimers({ toFake: ["Date"] });
      try {
        vi.setSystemTime(pastNow);
        expiredPutUrl = await storage.getSignedPutUrl(`contract/${crypto.randomUUID()}/expired.bin`, {
          contentType: "application/octet-stream",
          contentLength: payload.byteLength,
          expiresInSeconds: 1,
        });
        expiredGetUrl = await storage.getSignedGetUrl(key, { expiresInSeconds: 1 });
      }
      finally {
        vi.useRealTimers();
      }

      const expiredPutRes = await transfer(expiredPutUrl, {
        method: "PUT",
        headers: { "Content-Type": "application/octet-stream" },
        body: payload,
      });
      expect(expiredPutRes.status).toBe(403);
      await expiredPutRes.body?.cancel();

      const expiredGetRes = await transfer(expiredGetUrl, { method: "GET" });
      expect(expiredGetRes.status).toBe(403);
      await expiredGetRes.body?.cancel();
    });
  });
}
