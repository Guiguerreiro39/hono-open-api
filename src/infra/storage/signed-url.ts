import type {
  StoragePort,
  StorageSignedGetOptions,
  StorageSignedPutOptions,
  StorageSignedRequestContext,
} from "@/core/ports/storage";
import { Buffer } from "node:buffer";
import { createHmac, timingSafeEqual } from "node:crypto";

import { PayloadTooLargeError } from "@/core/errors";

import {
  assertValidSignedPutOptions,
  assertValidStorageKey,
  bodyToUint8Array,
  resolvePresignExpiresIn,
} from "./key";

const DEFAULT_EXPIRES_IN_SECONDS = 900;
const DEFAULT_MAX_PRESIGN_BYTES = 104_857_600;
const SHA256_HEX_REGEX = /^[0-9a-f]{64}$/;
const SAFE_HEADER_VALUE_REGEX = /^[\t\x20-\x7E\x80-\xFF]*$/;

export interface SignedStorageHandlerOptions {
  storage: Pick<StoragePort, "put" | "get" | "head">;
  signingSecret: string;
  baseUrl?: string;
  defaultExpiresInSeconds?: number;
  maxPresignBytes?: number;
}

interface SignedStorageHandlers {
  getSignedPutUrl: (key: string, opts: StorageSignedPutOptions) => Promise<string>;
  getSignedGetUrl: (key: string, opts?: StorageSignedGetOptions) => Promise<string>;
  handleSignedRequest: (req: Request, context?: StorageSignedRequestContext) => Promise<Response>;
}

function signPayload(secret: string, parts: string[]): string {
  return createHmac("sha256", secret)
    .update(JSON.stringify(parts))
    .digest("hex");
}

function verifySignature(secret: string, parts: string[], providedSig: string): boolean {
  if (!SHA256_HEX_REGEX.test(providedSig)) {
    return false;
  }
  const expectedSig = signPayload(secret, parts);
  return timingSafeEqual(
    Buffer.from(expectedSig, "hex"),
    Buffer.from(providedSig, "hex"),
  );
}

function jsonError(status: number, code: string, message: string, requestId: string): Response {
  return Response.json(
    {
      error: {
        code,
        message,
        requestId,
      },
    },
    { status },
  );
}

export function createSignedStorageHandlers(
  options: SignedStorageHandlerOptions,
): SignedStorageHandlers {
  const {
    storage,
    signingSecret,
    baseUrl = "http://localhost:9999",
    defaultExpiresInSeconds = DEFAULT_EXPIRES_IN_SECONDS,
    maxPresignBytes = DEFAULT_MAX_PRESIGN_BYTES,
  } = options;

  const normalizedBase = baseUrl.replace(/\/+$/, "");

  return {
    async getSignedPutUrl(key, opts) {
      assertValidStorageKey(key);
      assertValidSignedPutOptions(opts);
      const expiresIn = resolvePresignExpiresIn(opts.expiresInSeconds, defaultExpiresInSeconds);

      const exp = String(Math.floor(Date.now() + expiresIn * 1000));
      const len = String(opts.contentLength);
      const sig = signPayload(signingSecret, ["PUT", key, exp, opts.contentType, len]);

      const url = new URL(`${normalizedBase}/_storage/object`);
      url.searchParams.set("key", key);
      url.searchParams.set("exp", exp);
      url.searchParams.set("ct", opts.contentType);
      url.searchParams.set("len", len);
      url.searchParams.set("sig", sig);
      return url.toString();
    },

    async getSignedGetUrl(key, opts) {
      assertValidStorageKey(key);
      const expiresIn = resolvePresignExpiresIn(opts?.expiresInSeconds, defaultExpiresInSeconds);

      const exp = String(Math.floor(Date.now() + expiresIn * 1000));
      const ct = opts?.responseContentType ?? "";
      const cd = opts?.responseContentDisposition ?? "";
      const sig = signPayload(signingSecret, ["GET", key, exp, ct, cd]);

      const url = new URL(`${normalizedBase}/_storage/object`);
      url.searchParams.set("key", key);
      url.searchParams.set("exp", exp);
      if (ct) {
        url.searchParams.set("ct", ct);
      }
      if (cd) {
        url.searchParams.set("cd", cd);
      }
      url.searchParams.set("sig", sig);
      return url.toString();
    },

    async handleSignedRequest(req, context) {
      const requestId = context?.requestId ?? req.headers.get("x-request-id") ?? "unknown";
      const method = req.method.toUpperCase();

      if (method !== "PUT" && method !== "GET") {
        return jsonError(405, "METHOD_NOT_ALLOWED", "Method not allowed", requestId);
      }

      const url = new URL(req.url);
      const key = url.searchParams.get("key");
      const expRaw = url.searchParams.get("exp");
      const sig = url.searchParams.get("sig");

      if (!key || !expRaw || !sig) {
        return jsonError(403, "FORBIDDEN", "Invalid signed storage URL", requestId);
      }

      try {
        assertValidStorageKey(key);
      }
      catch {
        return jsonError(403, "FORBIDDEN", "Invalid storage key", requestId);
      }

      if (!/^\d+$/.test(expRaw)) {
        return jsonError(403, "FORBIDDEN", "Invalid signed storage URL", requestId);
      }
      const exp = Number(expRaw);
      if (!Number.isSafeInteger(exp)) {
        return jsonError(403, "FORBIDDEN", "Invalid signed storage URL", requestId);
      }

      if (method === "PUT") {
        const ct = url.searchParams.get("ct") ?? "";
        const lenRaw = url.searchParams.get("len");
        if (!lenRaw || !/^\d+$/.test(lenRaw)) {
          return jsonError(403, "FORBIDDEN", "Invalid signed storage URL", requestId);
        }
        const expectedLength = Number(lenRaw);
        if (!Number.isSafeInteger(expectedLength) || expectedLength < 0) {
          return jsonError(403, "FORBIDDEN", "Invalid signed storage URL", requestId);
        }

        if (!verifySignature(signingSecret, ["PUT", key, expRaw, ct, lenRaw], sig)) {
          return jsonError(403, "FORBIDDEN", "Invalid storage signature", requestId);
        }

        if (Date.now() >= exp) {
          return jsonError(403, "FORBIDDEN", "Signed storage URL has expired", requestId);
        }

        if (expectedLength > maxPresignBytes) {
          return jsonError(413, "PAYLOAD_TOO_LARGE", "Upload exceeds maximum signed size", requestId);
        }

        const contentLengthHeader = req.headers.get("content-length");
        if (contentLengthHeader !== null) {
          if (!/^\d+$/.test(contentLengthHeader) || Number(contentLengthHeader) !== expectedLength) {
            return jsonError(403, "FORBIDDEN", "Content-Length does not match signed length", requestId);
          }
        }

        let payload: Uint8Array;
        try {
          payload = req.body ? await bodyToUint8Array(req.body, expectedLength) : new Uint8Array(0);
        }
        catch (err) {
          if (err instanceof PayloadTooLargeError) {
            return jsonError(403, "FORBIDDEN", "Request body length does not match signed length", requestId);
          }
          throw err;
        }
        if (payload.byteLength !== expectedLength) {
          return jsonError(403, "FORBIDDEN", "Request body length does not match signed length", requestId);
        }

        await storage.put(key, payload, {
          contentType: ct || "application/octet-stream",
          contentLength: payload.byteLength,
        });

        return new Response(null, { status: 200 });
      }

      const ct = url.searchParams.get("ct") ?? "";
      const cd = url.searchParams.get("cd") ?? "";

      if (!verifySignature(signingSecret, ["GET", key, expRaw, ct, cd], sig)) {
        return jsonError(403, "FORBIDDEN", "Invalid storage signature", requestId);
      }

      if (Date.now() >= exp) {
        return jsonError(403, "FORBIDDEN", "Signed storage URL has expired", requestId);
      }

      if (!SAFE_HEADER_VALUE_REGEX.test(ct) || !SAFE_HEADER_VALUE_REGEX.test(cd)) {
        return jsonError(400, "BAD_REQUEST", "Invalid signed response header parameter", requestId);
      }

      const [meta, stream] = await Promise.all([
        storage.head(key),
        storage.get(key),
      ]);

      if (!meta || !stream) {
        await stream?.cancel();
        return jsonError(404, "NOT_FOUND", "Not found", requestId);
      }

      const headers = new Headers({
        "Content-Type": ct || meta.contentType || "application/octet-stream",
        "Content-Length": String(meta.size),
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "private, no-store",
      });
      if (cd) {
        headers.set("Content-Disposition", cd);
      }

      return new Response(stream, {
        status: 200,
        headers,
      });
    },
  };
}
