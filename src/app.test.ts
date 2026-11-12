import { createRoute, z } from "@hono/zod-openapi";
import { hc } from "hono/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createApp } from "@/app";
import { createLogger } from "@/core/logger";
import { AUTH_SECURITY } from "@/core/openapi";
import { parseEnv } from "@/env";
import { createTestApp } from "../tests/helpers/test-app";

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
      auth: {
        getSession: async () => null,
        hasPermission: async () => false,
        updateProfile: async () => {
          throw new Error("Not implemented");
        },
        handler: async () => new Response("Not implemented", { status: 501 }),
      },
      checkDb: () => new Promise(() => {}),
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
});
