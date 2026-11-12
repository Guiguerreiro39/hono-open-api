import type { Client } from "@libsql/client";
import type { Logger } from "pino";

import type { PubSubPort } from "@/core/ports/pubsub";
import type { QueuePort } from "@/core/ports/queue";
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
  isShuttingDown: () => boolean;
  shutdownSignal: AbortSignal;
  markShuttingDown: () => void;
  abortShutdown: () => void;
  forceDisconnect: () => void;
  close: () => Promise<void>;
}

export interface CreateContainerOptions {
  worker?: boolean;
}

export interface ContainerCloseStep {
  name: string;
  close: () => Promise<void> | void;
}

export async function executeCloseSteps(
  steps: readonly ContainerCloseStep[],
  logger: Pick<Logger, "warn">,
): Promise<void> {
  for (const step of steps) {
    try {
      await step.close();
    }
    catch (err) {
      logger.warn({ err, step: step.name }, "Container teardown step failed");
    }
  }
}

export function createContainer(env: Env, options?: CreateContainerOptions): Container {
  const logger = createLogger(env);
  const metrics = createMetricsAdapter(env);
  const { db, client, ping, close: closeDb } = createDb(env);
  const { auth: betterAuth, port: auth } = createAuthAdapter(env, db);
  const { port: storage, close: closeStorage } = createStorageAdapter(env);
  const taskRepository = createDrizzleTaskRepository(db);
  const shutdownController = new AbortController();
  let shuttingDown = false;
  let closePromise: Promise<void> | null = null;
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

  const queue: QueuePort = env.REDIS_URL
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

  const pubsub: PubSubPort = redisHandle
    ? new RedisPubSubAdapter({
        pub: redisHandle.client,
        ping: redisHandle.ping,
        prefix: env.CACHE_PREFIX,
        logger,
      })
    : new MemoryPubSubAdapter({ logger });

  const markShuttingDown = () => {
    shuttingDown = true;
  };

  const abortShutdown = () => {
    shuttingDown = true;
    if (!shutdownController.signal.aborted) {
      shutdownController.abort();
    }
  };

  const forceDisconnect = () => {
    abortShutdown();
    queue.forceClose?.();
    pubsub.forceDisconnect?.();
    redisHandle?.client.disconnect();
  };

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
    checkDb: ping,
    checkRedis: redisHandle?.ping,
    isShuttingDown: () => shuttingDown || shutdownController.signal.aborted,
    shutdownSignal: shutdownController.signal,
    markShuttingDown,
    abortShutdown,
    forceDisconnect,
    close: () => {
      if (closePromise) {
        return closePromise;
      }

      abortShutdown();
      const steps: ContainerCloseStep[] = [
        { name: "queue", close: () => queue.close() },
        { name: "pubsub", close: () => pubsub.close() },
        { name: "rateLimiter", close: () => rateLimiter.close() },
        ...(redisHandle ? [{ name: "redis", close: () => redisHandle.quit() }] : []),
        { name: "storage", close: () => closeStorage() },
        { name: "db", close: () => closeDb() },
      ];

      closePromise = executeCloseSteps(steps, logger);
      return closePromise;
    },
  };
}
