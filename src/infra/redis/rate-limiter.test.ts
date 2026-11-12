import { createServer } from "node:net";
import { Writable } from "node:stream";
import { requestId } from "hono/request-id";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createErrorHandler } from "@/core/errors";
import { createRouter } from "@/core/http";
import { createLogger } from "@/core/logger";
import { parseEnv } from "@/env";
import { PromMetricsAdapter } from "@/infra/observability";
import { createRedisClient } from "@/infra/redis/client";
import {
  MemoryRateLimiterAdapter,
  RedisRateLimiterAdapter,
  toHonoRateLimiterClient,
} from "@/infra/redis/rate-limiter";
import { defineRateLimiterContract } from "../../../tests/contracts/rate-limiter.contract";

defineRateLimiterContract("MemoryRateLimiterAdapter", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
  const rateLimiter = new MemoryRateLimiterAdapter();

  return {
    rateLimiter,
    windowMs: 60_000,
    advanceTimeMs: async (ms: number) => {
      await vi.advanceTimersByTimeAsync(ms);
    },
    cleanup: async () => {
      await rateLimiter.close();
      vi.useRealTimers();
    },
  };
});

describe("rate limiter adapters and fail-open behavior", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    vi.useRealTimers();
    while (cleanups.length > 0) {
      await cleanups.pop()?.();
    }
  });

  it("adapts ioredis commands via 4-method toHonoRateLimiterClient", async () => {
    const calls: unknown[][] = [];
    const fakeRedis = {
      script: async (...args: unknown[]) => {
        calls.push(["script", ...args]);
        return "sha-123";
      },
      evalsha: async (...args: unknown[]) => {
        calls.push(["evalsha", ...args]);
        return [1, 60_000];
      },
      decr: async (key: string) => {
        calls.push(["decr", key]);
        return 0;
      },
      del: async (...keys: string[]) => {
        calls.push(["del", ...keys]);
        return 1;
      },
    };

    const client = toHonoRateLimiterClient(fakeRedis as never);
    expect(await client.scriptLoad("return 1")).toBe("sha-123");
    expect(await client.evalsha("sha-123", ["k1"], ["0", "60000"])).toEqual([1, 60_000]);
    expect(await client.decr("k1")).toBe(0);
    expect(await client.del("k1")).toBe(1);

    expect(calls).toEqual([
      ["script", "LOAD", "return 1"],
      ["evalsha", "sha-123", 1, "k1", "0", "60000"],
      ["decr", "k1"],
      ["del", "k1"],
    ]);
  });

  it("fails open on unreachable Redis in both consume and middleware with warn logs and MetricsPort", async () => {
    const closedPort = await new Promise<number>((resolve, reject) => {
      const server = createServer();
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address();
        if (!addr || typeof addr === "string") {
          server.close(() => reject(new Error("Expected numeric port")));
          return;
        }
        server.close(err => err ? reject(err) : resolve(addr.port));
      });
    });

    const lines: string[] = [];
    const sink = new Writable({
      write(chunk, _encoding, cb) {
        lines.push(chunk.toString("utf8"));
        cb();
      },
    });
    const env = parseEnv({ NODE_ENV: "test", LOG_LEVEL: "warn" });
    const logger = createLogger(env, sink);
    const metrics = new PromMetricsAdapter({ collectDefaultMetrics: false });

    const handle = createRedisClient({
      url: `redis://127.0.0.1:${closedPort}`,
      logger,
      connectionName: "rl-fail-open-test",
    });
    cleanups.push(handle.quit);

    const limiter = new RedisRateLimiterAdapter({
      client: handle.client,
      prefix: "app",
      logger,
      metrics,
    });
    cleanups.push(limiter.close);

    const consumeRes = await limiter.consume({ tier: "api", limit: 2, windowMs: 60_000 }, "user:1");
    expect(consumeRes.allowed).toBe(true);
    expect(consumeRes.failedOpen).toBe(true);

    const app = createRouter()
      .use("*", requestId())
      .onError(createErrorHandler())
      .use(
        "/test",
        limiter.middleware({
          tier: "auth_mutation",
          limit: 1,
          windowMs: 60_000,
          keyGenerator: () => "ip:1.2.3.4",
        }),
      )
      .get("/test", c => c.json({ ok: true }, 200));

    const res1 = await app.request("/test");
    const res2 = await app.request("/test");
    expect(res1.status).toBe(200);
    expect(res2.status).toBe(200);

    await expect(limiter.resetKey("api", "user:1")).resolves.toBeUndefined();

    const { body } = await metrics.render();
    expect(body).toContain("rate_limit_decisions_total{tier=\"api\",decision=\"error\"} 1");
    expect(body).toContain("rate_limit_decisions_total{tier=\"auth_mutation\",decision=\"error\"} 2");

    const warnEntries = lines
      .join("")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map(line => JSON.parse(line) as Record<string, unknown>)
      .filter(entry => entry.level === 40);
    expect(warnEntries.length).toBeGreaterThanOrEqual(3);
  });

  it("records allowed and limited metrics cleanly in MemoryRateLimiterAdapter", async () => {
    const metrics = new PromMetricsAdapter({ collectDefaultMetrics: false });
    const limiter = new MemoryRateLimiterAdapter({ metrics });
    cleanups.push(limiter.close);

    const app = createRouter()
      .use("*", requestId())
      .onError(createErrorHandler())
      .use(
        "/items",
        limiter.middleware({
          tier: "api",
          limit: 1,
          windowMs: 60_000,
          keyGenerator: () => "ip:127.0.0.1",
        }),
      )
      .get("/items", c => c.json({ ok: true }, 200));

    expect((await app.request("/items")).status).toBe(200);
    expect((await app.request("/items")).status).toBe(429);

    const { body } = await metrics.render();
    expect(body).toContain("rate_limit_decisions_total{tier=\"api\",decision=\"allowed\"} 1");
    expect(body).toContain("rate_limit_decisions_total{tier=\"api\",decision=\"limited\"} 1");
  });
});
