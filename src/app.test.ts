import type { TaskRepository } from "@/modules/tasks/tasks.repository";
import { Writable } from "node:stream";
import { createRoute, z } from "@hono/zod-openapi";
import { hc } from "hono/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createApp } from "@/app";
import { createLogger } from "@/core/logger";
import { AUTH_SECURITY } from "@/core/openapi";
import { parseEnv } from "@/env";
import { NoopMetricsAdapter, PromMetricsAdapter } from "@/infra/observability";
import { createMemoryStorageAdapter } from "@/infra/storage/memory";
import { createTestApp } from "../tests/helpers/test-app";

const stubTaskRepository: TaskRepository = {
  list: async () => ({ data: [], meta: { nextCursor: null, hasMore: false } }),
  findById: async () => null,
  create: async () => {
    throw new Error("Not implemented");
  },
  update: async () => null,
  delete: async () => false,
};

describe("createApp global middleware stack", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    vi.useRealTimers();
    while (cleanups.length > 0) {
      await cleanups.pop()?.();
    }
  });

  it("propagates valid X-Request-Id, replaces invalid ones, and enforces secureHeaders + CORS", async () => {
    const ctx = await createTestApp({
      CORS_ORIGINS: "http://localhost:3000,https://allowed.example.com",
    });
    cleanups.push(ctx.cleanup);

    const validRes = await ctx.app.request("/health", {
      headers: {
        "X-Request-Id": "valid-req_123",
        "Origin": "https://allowed.example.com",
      },
    });
    expect(validRes.status).toBe(200);
    expect(validRes.headers.get("X-Request-Id")).toBe("valid-req_123");
    expect(validRes.headers.get("Access-Control-Allow-Origin")).toBe("https://allowed.example.com");
    expect(validRes.headers.get("Access-Control-Allow-Credentials")).toBe("true");
    expect(validRes.headers.get("X-Content-Type-Options")).toBe("nosniff");

    const invalidIdRes = await ctx.app.request("/missing-route", {
      headers: {
        "X-Request-Id": "bad id with spaces!",
        "Origin": "https://evil.example.com",
      },
    });
    expect(invalidIdRes.status).toBe(404);
    const generatedId = invalidIdRes.headers.get("X-Request-Id");
    expect(generatedId).toBeTruthy();
    expect(generatedId).not.toBe("bad id with spaces!");
    expect(invalidIdRes.headers.get("Access-Control-Allow-Origin")).toBeNull();
    expect(await invalidIdRes.json()).toEqual({
      error: {
        code: "NOT_FOUND",
        message: "Not found",
        requestId: generatedId,
      },
    });
  });

  it("rejects request bodies larger than 1 MB with 413 canonical error envelope", async () => {
    const ctx = await createTestApp();
    cleanups.push(ctx.cleanup);

    const oversizedBody = "x".repeat(1024 * 1024 + 1);
    const res = await ctx.app.request("/not-found-post", {
      method: "POST",
      headers: {
        "Content-Type": "text/plain",
        "X-Request-Id": "req-too-large",
      },
      body: oversizedBody,
    });

    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({
      error: {
        code: "PAYLOAD_TOO_LARGE",
        message: "Request body exceeds 1 MB limit",
        requestId: "req-too-large",
      },
    });
  });

  it("times out slow requests at 30s with 408 canonical error envelope", async () => {
    vi.useFakeTimers();

    const env = parseEnv({ NODE_ENV: "test", READINESS_TIMEOUT_MS: 60_000 });
    const ac = new AbortController();
    const app = createApp({
      env,
      logger: createLogger(env),
      metrics: new NoopMetricsAdapter(),
      auth: {
        getSession: async () => null,
        hasPermission: async () => false,
        updateProfile: async () => {
          throw new Error("Not implemented");
        },
        handler: async () => new Response("Not implemented", { status: 501 }),
      },
      taskRepository: stubTaskRepository,
      checkDb: () => new Promise(() => {}),
      storage: createMemoryStorageAdapter({ signingSecret: env.STORAGE_SIGNING_SECRET }),
      isShuttingDown: () => false,
      shutdownSignal: ac.signal,
    });
    cleanups.push(async () => {
      ac.abort();
    });

    const responsePromise = app.request("/ready", {
      headers: { "X-Request-Id": "req-timeout" },
    });

    await vi.advanceTimersByTimeAsync(30_000);
    const res = await responsePromise;

    expect(res.status).toBe(408);
    expect(await res.json()).toEqual({
      error: {
        code: "REQUEST_TIMEOUT",
        message: "Request timeout",
        requestId: "req-timeout",
      },
    });
  });

  it("preserves AppType inference for hc<AppType> and exports typed AUTH_SECURITY", async () => {
    expect(AUTH_SECURITY).toEqual([
      { bearerAuth: [] },
      { cookieAuth: [] },
    ]);

    const protectedRoute = createRoute({
      method: "get",
      path: "/protected",
      security: AUTH_SECURITY,
      responses: {
        200: {
          description: "OK",
          content: { "application/json": { schema: z.object({ ok: z.boolean() }) } },
        },
      },
    });
    expect(protectedRoute.security).toEqual(AUTH_SECURITY);

    const ctx = await createTestApp();
    cleanups.push(ctx.cleanup);

    const client = hc<typeof ctx.app>("http://localhost", {
      fetch: (input: RequestInfo | URL, init?: RequestInit) => ctx.app.request(input, init),
    });

    const res = await client.health.$get();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("ok");
  });

  it("exempts /_storage/* from the 30s timeout and 1 MB bodyLimit while returning 404 under s3", async () => {
    const ctx = await createTestApp();
    cleanups.push(ctx.cleanup);

    const largePayload = new Uint8Array(1024 * 1024 + 512).fill(42);
    const putUrl = await ctx.container.storage.getSignedPutUrl("large/blob.bin", {
      contentType: "application/octet-stream",
      contentLength: largePayload.byteLength,
      expiresInSeconds: 60,
    });

    const putRes = await ctx.app.request(putUrl, {
      method: "PUT",
      headers: { "Content-Type": "application/octet-stream" },
      body: largePayload,
    });
    expect(putRes.status).toBe(200);

    const getUrl = await ctx.container.storage.getSignedGetUrl("large/blob.bin", {
      expiresInSeconds: 60,
    });
    const getRes = await ctx.app.request(getUrl, { method: "GET" });
    expect(getRes.status).toBe(200);
    expect(new Uint8Array(await getRes.arrayBuffer())).toEqual(largePayload);

    const tamperedUrl = new URL(getUrl);
    tamperedUrl.searchParams.set("sig", "0".repeat(64));
    const tamperedRes = await ctx.app.request(tamperedUrl.toString(), {
      headers: { "X-Request-Id": "req-tampered" },
    });
    expect(tamperedRes.status).toBe(403);
    expect(await tamperedRes.json()).toEqual({
      error: {
        code: "FORBIDDEN",
        message: "Invalid storage signature",
        requestId: "req-tampered",
      },
    });

    const s3Ctx = await createTestApp({
      STORAGE_DRIVER: "s3",
      S3_BUCKET: "test-bucket",
      S3_ENDPOINT: "http://localhost:9000",
      S3_FORCE_PATH_STYLE: "true",
    });
    cleanups.push(s3Ctx.cleanup);

    const s3Get = await s3Ctx.app.request("/_storage/object?key=abc", {
      headers: { "X-Request-Id": "req-s3-404" },
    });
    expect(s3Get.status).toBe(404);
    expect(await s3Get.json()).toEqual({
      error: {
        code: "NOT_FOUND",
        message: "Not found",
        requestId: "req-s3-404",
      },
    });

    const s3Put = await s3Ctx.app.request("/_storage/object?key=abc", {
      method: "PUT",
      body: new Uint8Array([1, 2, 3]),
      headers: { "X-Request-Id": "req-s3-put-404" },
    });
    expect(s3Put.status).toBe(404);

    vi.useFakeTimers();
    const env = parseEnv({ NODE_ENV: "test" });
    const ac = new AbortController();
    const memStorage = createMemoryStorageAdapter({ signingSecret: env.STORAGE_SIGNING_SECRET });
    const slowApp = createApp({
      env,
      logger: createLogger(env),
      metrics: new NoopMetricsAdapter(),
      auth: {
        getSession: async () => null,
        hasPermission: async () => false,
        updateProfile: async () => {
          throw new Error("Not implemented");
        },
        handler: async () => new Response("Not implemented", { status: 501 }),
      },
      taskRepository: stubTaskRepository,
      checkDb: async () => {},
      storage: {
        put: (k, b, o) => memStorage.put(k, b, o),
        get: (k, o) => memStorage.get(k, o),
        head: k => memStorage.head(k),
        delete: k => memStorage.delete(k),
        getSignedPutUrl: (k, o) => memStorage.getSignedPutUrl(k, o),
        getSignedGetUrl: (k, o) => memStorage.getSignedGetUrl(k, o),
        handleSignedRequest: () =>
          new Promise<Response>((resolve) => {
            setTimeout(() => resolve(new Response("slow-ok", { status: 200 })), 35_000);
          }),
      },
      isShuttingDown: () => false,
      shutdownSignal: ac.signal,
    });
    cleanups.push(async () => {
      ac.abort();
    });

    const slowPromise = slowApp.request("/_storage/object?key=slow");
    await vi.advanceTimersByTimeAsync(35_000);
    const slowRes = await slowPromise;
    expect(slowRes.status).toBe(200);
    expect(await slowRes.text()).toBe("slow-ok");
  });

  it("correlates requestId and traceparent into HTTP logs and skips SSE durations in createApp", async () => {
    const lines: string[] = [];
    const sink = new Writable({
      write(chunk, _encoding, callback) {
        lines.push(chunk.toString("utf8"));
        callback();
      },
    });
    const env = parseEnv({ NODE_ENV: "test", LOG_LEVEL: "info" });
    const logger = createLogger(env, sink);
    const metrics = new PromMetricsAdapter({ collectDefaultMetrics: false });
    const ac = new AbortController();
    cleanups.push(async () => {
      ac.abort();
    });

    const app = createApp({
      env,
      logger,
      metrics,
      auth: {
        getSession: async () => null,
        hasPermission: async () => false,
        updateProfile: async () => {
          throw new Error("Not implemented");
        },
        handler: async () => new Response("event: ping\ndata: {}\n\n", {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        }),
      },
      taskRepository: stubTaskRepository,
      checkDb: async () => {},
      storage: createMemoryStorageAdapter({ signingSecret: env.STORAGE_SIGNING_SECRET }),
      isShuttingDown: () => false,
      shutdownSignal: ac.signal,
    });

    const traceId = "4bf92f3577b34da6a3ce929d0e0e4736";
    const rootRes = await app.request("/", {
      headers: {
        "X-Request-Id": "req-app-trace",
        "traceparent": `00-${traceId}-00f067aa0ba902b7-01`,
      },
    });

    expect(rootRes.status).toBe(200);
    expect(rootRes.headers.get("X-Request-Id")).toBe("req-app-trace");
    expect(rootRes.headers.get("traceparent")).toBeNull();

    const sseRes = await app.request("/api/auth/stream-stub", {
      headers: {
        traceparent: "bad-header",
      },
    });
    expect(sseRes.status).toBe(200);
    await sseRes.text();

    const entries = lines
      .join("")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map(line => JSON.parse(line) as Record<string, unknown>);

    expect(entries).toHaveLength(2);
    expect(entries[0].reqId).toBe("req-app-trace");
    expect(entries[0].trace_id).toBe(traceId);
    expect(entries[0].span_id).toMatch(/^[0-9a-f]{16}$/);

    expect(entries[1].trace_id).toMatch(/^[0-9a-f]{32}$/);
    expect(entries[1].span_id).toMatch(/^[0-9a-f]{16}$/);

    const metricsRes = await app.request("/metrics");
    const metricsBody = await metricsRes.text();
    expect(metricsBody).toContain("http_requests_total{method=\"GET\",route=\"/api/auth/*\",status=\"200\"} 1");
    expect(metricsBody).not.toContain("http_request_duration_seconds_count{method=\"GET\",route=\"/api/auth/*\"");
  });
});
