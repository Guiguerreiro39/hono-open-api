import type { Client } from "@libsql/client";

import type { PlatformDeps } from "@/core/types";
import type { Env } from "@/env";
import type { AppAuth } from "@/infra/auth";
import type { AppDatabase } from "@/infra/db/client";
import { createLogger } from "@/core/logger";
import { createAuthAdapter } from "@/infra/auth";
import { createDb } from "@/infra/db/client";
import { createMetricsAdapter } from "@/infra/observability";
import {
  createRedisClient,
  MemoryCacheAdapter,
  MemoryRateLimiterAdapter,
  RedisCacheAdapter,
  RedisRateLimiterAdapter,
} from "@/infra/redis";

export interface Container extends PlatformDeps {
  db: AppDatabase;
  client: Client;
  betterAuth: AppAuth;
  close: () => Promise<void>;
}

export function createContainer(env: Env): Container {
  const logger = createLogger(env);
  const metrics = createMetricsAdapter(env);
  const { db, client, ping, close: closeDb } = createDb(env);
  const { auth: betterAuth, port: auth } = createAuthAdapter(env, db);
  const shutdownController = new AbortController();

  const redisHandle = env.REDIS_URL
    ? createRedisClient({
        url: env.REDIS_URL,
        logger,
        connectionName: "api",
      })
    : undefined;

  const cache = redisHandle
    ? new RedisCacheAdapter({
        client: redisHandle.client,
        ping: redisHandle.ping,
        prefix: env.CACHE_PREFIX,
        logger,
        metrics,
      })
    : new MemoryCacheAdapter({
        prefix: env.CACHE_PREFIX,
        metrics,
      });

  const rateLimiter = redisHandle
    ? new RedisRateLimiterAdapter({
        client: redisHandle.client,
        prefix: env.CACHE_PREFIX,
        logger,
        metrics,
      })
    : new MemoryRateLimiterAdapter({ metrics });

  return {
    env,
    logger,
    metrics,
    auth,
    cache,
    rateLimiter,
    betterAuth,
    db,
    client,
    checkDb: ping,
    checkRedis: redisHandle?.ping,
    isShuttingDown: () => shutdownController.signal.aborted,
    shutdownSignal: shutdownController.signal,
    close: async () => {
      if (!shutdownController.signal.aborted) {
        shutdownController.abort();
      }
      await rateLimiter.close();
      if (redisHandle) {
        await redisHandle.quit();
      }
      await closeDb();
    },
  };
}
