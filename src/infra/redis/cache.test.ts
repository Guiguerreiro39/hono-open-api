import { createServer } from "node:net";
import { Writable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createLogger } from "@/core/logger";
import { parseEnv } from "@/env";
import { PromMetricsAdapter } from "@/infra/observability";
import { createRedisClient } from "@/infra/redis/client";
import { MemoryCacheAdapter } from "@/infra/redis/memory-cache";
import { RedisCacheAdapter } from "@/infra/redis/redis-cache";
import { defineCacheContract } from "../../../tests/contracts/cache.contract";

defineCacheContract("MemoryCacheAdapter", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
  const cache = new MemoryCacheAdapter({ prefix: "test" });

  return {
    cache,
    advanceTimeMs: async (ms: number) => {
      await vi.advanceTimersByTimeAsync(ms);
    },
    cleanup: async () => {
      cache.clear();
      vi.useRealTimers();
    },
  };
});

describe("memory cache adapter specifics", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("evicts oldest entries beyond maxEntries (1000 default), supports clear(), and creates zero setInterval timers", async () => {
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
    const bounded = new MemoryCacheAdapter({ maxEntries: 3 });

    expect(setIntervalSpy).not.toHaveBeenCalled();

    await bounded.set("ns", "k1", 1);
    await bounded.set("ns", "k2", 2);
    await bounded.set("ns", "k3", 3);
    await bounded.set("ns", "k4", 4);

    expect(await bounded.get("ns", "k1")).toBeUndefined();
    expect(await bounded.get("ns", "k2")).toBe(2);
    expect(await bounded.get("ns", "k3")).toBe(3);
    expect(await bounded.get("ns", "k4")).toBe(4);

    const defaultBounded = new MemoryCacheAdapter();
    expect(defaultBounded.maxEntries).toBe(1000);
    for (let i = 0; i < 1005; i++) {
      await defaultBounded.set("bulk", `item-${i}`, i);
    }
    expect(await defaultBounded.get("bulk", "item-0")).toBeUndefined();
    expect(await defaultBounded.get("bulk", "item-1004")).toBe(1004);

    defaultBounded.clear();
    expect(await defaultBounded.get("bulk", "item-1004")).toBeUndefined();

    setIntervalSpy.mockRestore();
  });

  it("records MetricsPort cache operations and handles non-positive TTL safely", async () => {
    const metrics = new PromMetricsAdapter({ collectDefaultMetrics: false });
    const cache = new MemoryCacheAdapter({ metrics });

    await cache.get("ns", "miss");
    await cache.set("ns", "hit", "val");
    await cache.get("ns", "hit");
    await cache.set("ns", "zero-ttl", "gone", 0);
    expect(await cache.get("ns", "zero-ttl")).toBeUndefined();
    await cache.del("ns", "hit");
    await cache.invalidateNamespace("ns");

    const { body } = await metrics.render();
    expect(body).toContain("cache_operations_total{operation=\"get\",result=\"miss\"} 2");
    expect(body).toContain("cache_operations_total{operation=\"get\",result=\"hit\"} 1");
    expect(body).toContain("cache_operations_total{operation=\"set\",result=\"ok\"} 2");
    expect(body).toContain("cache_operations_total{operation=\"del\",result=\"ok\"} 1");
    expect(body).toContain("cache_operations_total{operation=\"invalidate\",result=\"ok\"} 1");
  });
});

describe("redis cache adapter specifics", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cleanups.length > 0) {
      await cleanups.pop()?.();
    }
  });

  it("formats prefix:namespace:vN:key keys with O(1) version bumps and cached-null JSON wrapper", async () => {
    const store = new Map<string, string>();
    const setCalls: Array<{ key: string; value: string; ttl: number }> = [];

    const fakeRedis = {
      get: async (key: string) => store.get(key) ?? null,
      set: async (key: string, value: string, _mode: "EX", seconds: number) => {
        setCalls.push({ key, value, ttl: seconds });
        store.set(key, value);
        return "OK" as const;
      },
      del: async (key: string) => (store.delete(key) ? 1 : 0),
      incr: async (key: string) => {
        const next = Number(store.get(key) ?? "0") + 1;
        store.set(key, String(next));
        return next;
      },
      ping: async () => "PONG" as const,
    };

    const env = parseEnv({ NODE_ENV: "test", LOG_LEVEL: "silent" });
    const metrics = new PromMetricsAdapter({ collectDefaultMetrics: false });
    const cache = new RedisCacheAdapter({
      client: fakeRedis,
      prefix: "custom",
      logger: createLogger(env),
      metrics,
    });

    await cache.set("users", "u1", null);
    expect(setCalls[0]).toEqual({
      key: "custom:users:v0:u1",
      value: JSON.stringify({ v: null }),
      ttl: 300,
    });
    expect(await cache.get("users", "u1")).toBeNull();

    await cache.invalidateNamespace("users");
    expect(await cache.get("users", "u1")).toBeUndefined();

    await cache.set("users", "u2", { ok: true }, 45);
    expect(setCalls[1]).toEqual({
      key: "custom:users:v1:u2",
      value: JSON.stringify({ v: { ok: true } }),
      ttl: 45,
    });
  });

  it("fails open on unreachable Redis for cache ops with warn logs and MetricsPort error counts, while ping() rejects", async () => {
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
      connectionName: "cache-fail-open-test",
    });
    cleanups.push(handle.quit);

    const cache = new RedisCacheAdapter({
      client: handle.client,
      ping: handle.ping,
      prefix: "app",
      logger,
      metrics,
    });

    // ping must reject so /ready detects degraded Redis
    await expect(cache.ping()).rejects.toThrow();

    // Cache ops fail open without throwing
    expect(await cache.get("tasks", "t1")).toBeUndefined();
    await expect(cache.set("tasks", "t1", { id: "t1" })).resolves.toBeUndefined();
    await expect(cache.del("tasks", "t1")).resolves.toBeUndefined();
    await expect(cache.invalidateNamespace("tasks")).resolves.toBeUndefined();

    let loaderCalls = 0;
    const loaded = await cache.getOrSet("tasks", "t2", async () => {
      loaderCalls++;
      return { fresh: true };
    });
    expect(loaded).toEqual({ fresh: true });
    expect(loaderCalls).toBe(1);

    const { body } = await metrics.render();
    expect(body).toContain("cache_operations_total{operation=\"get\",result=\"error\"} 2");
    expect(body).toContain("cache_operations_total{operation=\"set\",result=\"error\"} 2");
    expect(body).toContain("cache_operations_total{operation=\"del\",result=\"error\"} 1");
    expect(body).toContain("cache_operations_total{operation=\"invalidate\",result=\"error\"} 1");

    const warnEntries = lines
      .join("")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map(line => JSON.parse(line) as Record<string, unknown>)
      .filter(entry => entry.level === 40);
    expect(warnEntries.length).toBeGreaterThanOrEqual(4);
  });
});
