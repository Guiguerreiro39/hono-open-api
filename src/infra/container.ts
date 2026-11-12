import type { Client } from "@libsql/client";

import type { PlatformDeps } from "@/core/types";
import type { Env } from "@/env";
import type { AppAuth } from "@/infra/auth";
import type { AppDatabase } from "@/infra/db/client";
import type { TaskRepository } from "@/modules/tasks/tasks.repository";
import { createLogger } from "@/core/logger";
import { createAuthAdapter } from "@/infra/auth";
import { createDb } from "@/infra/db/client";
import { createDrizzleTaskRepository } from "@/infra/db/repositories/drizzle-task.repository";
import { createMetricsAdapter } from "@/infra/observability";
import { MemoryPubSubAdapter, RedisPubSubAdapter } from "@/infra/realtime";
import {
  createRedisClient,
  MemoryCacheAdapter,
  MemoryRateLimiterAdapter,
  RedisCacheAdapter,
  RedisRateLimiterAdapter,
} from "@/infra/redis";
import { createStorageAdapter } from "@/infra/storage";

export interface Container extends PlatformDeps {
  db: AppDatabase;
  client: Client;
  betterAuth: AppAuth;
  taskRepository: TaskRepository;
  close: () => Promise<void>;
}

export function createContainer(env: Env): Container {
  const logger = createLogger(env);
  const metrics = createMetricsAdapter(env);
  const { db, client, ping, close: closeDb } = createDb(env);
  const { auth: betterAuth, port: auth } = createAuthAdapter(env, db);
  const { port: storage, close: closeStorage } = createStorageAdapter(env);
  const taskRepository = createDrizzleTaskRepository(db);
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

  const pubsub = redisHandle
    ? new RedisPubSubAdapter({
        pub: redisHandle.client,
        ping: redisHandle.ping,
        prefix: env.CACHE_PREFIX,
        logger,
      })
    : new MemoryPubSubAdapter({ logger });

  return {
    env,
    logger,
    metrics,
    auth,
    cache,
    rateLimiter,
    pubsub,
    storage,
    betterAuth,
    db,
    client,
    taskRepository,
    checkDb: ping,
    checkRedis: redisHandle?.ping,
    isShuttingDown: () => shutdownController.signal.aborted,
    shutdownSignal: shutdownController.signal,
    close: async () => {
      if (!shutdownController.signal.aborted) {
        shutdownController.abort();
      }
      await pubsub.close();
      await rateLimiter.close();
      if (redisHandle) {
        await redisHandle.quit();
      }
      await closeStorage();
      await closeDb();
    },
  };
}
