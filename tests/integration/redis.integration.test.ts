import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { createLogger } from "@/core/logger";
import { parseEnv } from "@/env";
import { PromMetricsAdapter } from "@/infra/observability";
import {
  createRedisClient,
  RedisCacheAdapter,
  RedisRateLimiterAdapter,
} from "@/infra/redis";
import { defineCacheContract } from "../contracts/cache.contract";
import { defineRateLimiterContract } from "../contracts/rate-limiter.contract";
import { createTestApp } from "../helpers/test-app";
import { getIntegrationEnv } from "./env";

const integrationEnv = getIntegrationEnv();
const REDIS_URL = integrationEnv.REDIS_URL;

async function assertRedisReachable(): Promise<void> {
  const env = parseEnv({ NODE_ENV: "test", LOG_LEVEL: "silent", REDIS_URL });
  const handle = createRedisClient({
    url: REDIS_URL,
    logger: createLogger(env),
    connectionName: "integration-preflight",
    connectTimeoutMs: 2000,
  });

  try {
    await handle.ping();
  }
  catch (err) {
    throw new Error(
      `Redis integration test requires a reachable Redis server at ${REDIS_URL}. Start it with "docker compose up -d --wait redis".`,
      { cause: err },
    );
  }
  finally {
    await handle.quit();
  }
}

beforeAll(async () => {
  await assertRedisReachable();
});

defineCacheContract("RedisCacheAdapter", async () => {
  const prefix = `int-cache-${crypto.randomUUID().slice(0, 8)}`;
  const env = parseEnv({
    NODE_ENV: "test",
    LOG_LEVEL: "silent",
    REDIS_URL,
    CACHE_PREFIX: prefix,
  });
  const logger = createLogger(env);
  const metrics = new PromMetricsAdapter({ collectDefaultMetrics: false });
  const handle = createRedisClient({
    url: REDIS_URL,
    logger,
    connectionName: prefix,
  });
  await handle.ping();

  const cache = new RedisCacheAdapter({
    client: handle.client,
    ping: handle.ping,
    prefix,
    logger,
    metrics,
  });

  return {
    cache,
    advanceTimeMs: ms => new Promise(resolve => setTimeout(resolve, ms)),
    cleanup: async () => {
      try {
        const keys = await handle.client.keys(`${prefix}:*`);
        if (keys.length > 0) {
          await handle.client.del(...keys);
        }
      }
      finally {
        await handle.quit();
      }
    },
  };
});

defineRateLimiterContract("RedisRateLimiterAdapter", async () => {
  const prefix = `int-rl-${crypto.randomUUID().slice(0, 8)}`;
  const env = parseEnv({
    NODE_ENV: "test",
    LOG_LEVEL: "silent",
    REDIS_URL,
    CACHE_PREFIX: prefix,
  });
  const logger = createLogger(env);
  const metrics = new PromMetricsAdapter({ collectDefaultMetrics: false });
  const handle = createRedisClient({
    url: REDIS_URL,
    logger,
    connectionName: prefix,
  });
  await handle.ping();

  const rateLimiter = new RedisRateLimiterAdapter({
    client: handle.client,
    prefix,
    logger,
    metrics,
  });

  return {
    rateLimiter,
    windowMs: 1000,
    advanceTimeMs: ms => new Promise(resolve => setTimeout(resolve, ms)),
    cleanup: async () => {
      try {
        const keys = await handle.client.keys(`${prefix}:*`);
        if (keys.length > 0) {
          await handle.client.del(...keys);
        }
      }
      finally {
        await rateLimiter.close();
        await handle.quit();
      }
    },
  };
});

describe("redis HTTP readiness and rate-limiting integration", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cleanups.length > 0) {
      await cleanups.pop()?.();
    }
  });

  it("reports healthy Redis on GET /ready and enforces Redis-backed rate limits across requests", async () => {
    const prefix = `int-http-${crypto.randomUUID().slice(0, 8)}`;
    const ctx = await createTestApp({
      REDIS_URL,
      CACHE_PREFIX: prefix,
      RATE_LIMIT_ENABLED: true,
    });

    const cleanupHandle = createRedisClient({
      url: REDIS_URL,
      logger: ctx.container.logger,
      connectionName: `${prefix}-cleanup`,
    });
    cleanups.push(async () => {
      try {
        await ctx.cleanup();
        await cleanupHandle.ping().catch(() => {});
        const keys = await cleanupHandle.client.keys(`${prefix}:*`);
        if (keys.length > 0) {
          await cleanupHandle.client.del(...keys);
        }
      }
      finally {
        await cleanupHandle.quit();
      }
    });

    const readyRes = await ctx.client.ready.$get();
    expect(readyRes.status).toBe(200);
    const readyBody = await readyRes.json();
    expect(readyBody.status).toBe("ok");
    expect(readyBody.checks.db.status).toBe("ok");
    expect(readyBody.checks.redis.status).toBe("ok");
    expect(typeof readyBody.checks.redis.latencyMs).toBe("number");

    for (let i = 0; i < 10; i++) {
      const res = await ctx.app.request("/api/auth/sign-in/email", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "nobody@example.com", password: "WrongPassword123!" }),
      });
      expect(res.status).toBe(401);
      expect(res.headers.get("RateLimit-Policy")).toBe("10;w=60");
    }

    const limitedRes = await ctx.app.request("/api/auth/sign-in/email", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "X-Request-Id": "req-redis-429",
      },
      body: JSON.stringify({ email: "nobody@example.com", password: "WrongPassword123!" }),
    });
    expect(limitedRes.status).toBe(429);
    expect(await limitedRes.json()).toEqual({
      error: {
        code: "RATE_LIMIT_EXCEEDED",
        message: "Too many requests",
        requestId: "req-redis-429",
      },
    });
  });
});
