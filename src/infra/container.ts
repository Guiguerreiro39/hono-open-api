import type { Client } from "@libsql/client";

import type { PlatformDeps } from "@/core/types";
import type { Env } from "@/env";
import type { AppAuth } from "@/infra/auth";
import type { AppDatabase } from "@/infra/db/client";
import type { FileRepository } from "@/modules/files/files.repository";
import type { TaskRepository } from "@/modules/tasks/tasks.repository";
import { createLogger } from "@/core/logger";
import { createAuthAdapter } from "@/infra/auth";
import { createDb } from "@/infra/db/client";
import { createDrizzleFileRepository } from "@/infra/db/repositories/drizzle-file.repository";
import { createDrizzleTaskRepository } from "@/infra/db/repositories/drizzle-task.repository";
import { createMetricsAdapter } from "@/infra/observability";
import { BullMQQueueAdapter, MemoryQueueAdapter } from "@/infra/queue";
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
  fileRepository: FileRepository;
  close: () => Promise<void>;
}

export interface CreateContainerOptions {
  worker?: boolean;
}

export function createContainer(env: Env, options?: CreateContainerOptions): Container {
  const logger = createLogger(env);
  const metrics = createMetricsAdapter(env);
  const { db, client, ping, close: closeDb } = createDb(env);
  const { auth: betterAuth, port: auth } = createAuthAdapter(env, db);
  const { port: storage, close: closeStorage } = createStorageAdapter(env);
  const taskRepository = createDrizzleTaskRepository(db);
  const fileRepository = createDrizzleFileRepository(db);
  const shutdownController = new AbortController();
  const workerEnabled = options?.worker ?? env.WORKER_EMBEDDED;

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

  const queue = env.REDIS_URL
    ? new BullMQQueueAdapter({
        redisUrl: env.REDIS_URL,
        prefix: env.CACHE_PREFIX,
        logger,
        metrics,
        worker: workerEnabled,
        concurrency: env.WORKER_CONCURRENCY,
        shutdownTimeoutMs: env.WORKER_SHUTDOWN_TIMEOUT_MS,
      })
    : new MemoryQueueAdapter({
        mode: env.NODE_ENV === "development" ? "auto" : "buffered",
        logger,
        metrics,
      });

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
    queue,
    pubsub,
    storage,
    betterAuth,
    db,
    client,
    taskRepository,
    fileRepository,
    checkDb: ping,
    checkRedis: redisHandle?.ping,
    isShuttingDown: () => shutdownController.signal.aborted,
    shutdownSignal: shutdownController.signal,
    close: async () => {
      if (!shutdownController.signal.aborted) {
        shutdownController.abort();
      }
      await queue.close();
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
