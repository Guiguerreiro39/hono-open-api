import type { Logger } from "pino";
import { Redis } from "ioredis";

export const MAX_REDIS_RECONNECT_DELAY_MS = 5000;

export function defaultRedisRetryStrategy(times: number): number {
  return Math.min(100 * 2 ** Math.max(0, times - 1), MAX_REDIS_RECONNECT_DELAY_MS);
}

export interface CreateRedisClientOptions {
  url: string;
  logger: Logger;
  connectionName?: string;
  lazyConnect?: boolean;
  enableOfflineQueue?: boolean;
  maxRetriesPerRequest?: number | null;
  connectTimeoutMs?: number;
  retryStrategy?: (times: number) => number | void | null;
}

export interface RedisClientHandle {
  client: Redis;
  ping: () => Promise<void>;
  quit: () => Promise<void>;
}

export interface RedisLifecycleClient {
  status: string;
  connect: () => Promise<unknown>;
  quit: () => Promise<unknown>;
  disconnect: () => void;
  once: (event: string, listener: (...args: any[]) => void) => unknown;
  off: (event: string, listener: (...args: any[]) => void) => unknown;
}

export async function awaitRedisHandshake(client: Pick<RedisLifecycleClient, "status" | "connect" | "once" | "off">): Promise<void> {
  if (client.status === "ready") {
    return;
  }
  if (client.status === "wait") {
    await client.connect();
    return;
  }
  if (client.status !== "connecting") {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    const onReady = () => {
      cleanup();
      resolve();
    };
    const onError = (err: Error) => {
      cleanup();
      reject(err);
    };
    const onClose = () => {
      cleanup();
      reject(new Error("Redis connection closed before ready"));
    };

    function cleanup() {
      client.off("ready", onReady);
      client.off("error", onError);
      client.off("close", onClose);
      client.off("end", onClose);
    }

    client.once("ready", onReady);
    client.once("error", onError);
    client.once("close", onClose);
    client.once("end", onClose);
  });
}

export async function pingRedisClient(client: Redis): Promise<void> {
  if (client.status === "wait" || client.status === "connecting") {
    await awaitRedisHandshake(client);
  }
  await client.ping();
}

export async function quitRedisClient(client: Pick<RedisLifecycleClient, "status" | "quit" | "disconnect">): Promise<void> {
  if (client.status === "end") {
    return;
  }
  if (client.status === "ready") {
    try {
      await client.quit();
      return;
    }
    catch {
      client.disconnect();
      return;
    }
  }
  client.disconnect();
}

export function createRedisClient(options: CreateRedisClientOptions): RedisClientHandle {
  const client = new Redis(options.url, {
    connectionName: options.connectionName,
    lazyConnect: options.lazyConnect ?? false,
    enableOfflineQueue: options.enableOfflineQueue ?? false,
    maxRetriesPerRequest: options.maxRetriesPerRequest !== undefined
      ? options.maxRetriesPerRequest
      : 2,
    connectTimeout: options.connectTimeoutMs ?? 10_000,
    retryStrategy: options.retryStrategy ?? defaultRedisRetryStrategy,
  });

  client.on("error", (err) => {
    options.logger.warn(
      { err, connectionName: options.connectionName },
      "Redis client error",
    );
  });

  return {
    client,
    ping: () => pingRedisClient(client),
    quit: () => quitRedisClient(client),
  };
}
