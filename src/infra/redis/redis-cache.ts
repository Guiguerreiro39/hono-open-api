import type { Logger } from "pino";
import type { CachePort, ScopedCache } from "@/core/ports/cache";
import type { MetricsPort } from "@/core/ports/metrics";
import { DEFAULT_CACHE_TTL_SECONDS } from "@/core/ports/cache";

import {
  buildCacheKey,
  buildNamespaceVersionKey,
  createScopedCache,
  deserializeCacheValue,
  serializeCacheValue,
} from "./cache-utils";

export interface RedisCacheClient {
  get: (key: string) => Promise<string | null>;
  set: (key: string, value: string, expiryMode: "EX", seconds: number) => Promise<unknown>;
  del: (key: string) => Promise<number>;
  incr: (key: string) => Promise<number>;
  ping: () => Promise<string>;
}

export interface RedisCacheAdapterOptions {
  client: RedisCacheClient;
  prefix?: string;
  defaultTtlSeconds?: number;
  logger: Logger;
  metrics?: MetricsPort;
  ping?: () => Promise<void>;
}

export class RedisCacheAdapter implements CachePort {
  readonly prefix: string;
  readonly defaultTtlSeconds: number;

  private readonly client: RedisCacheClient;
  private readonly logger: Logger;
  private readonly metrics?: MetricsPort;
  private readonly pingFn: () => Promise<void>;

  constructor(options: RedisCacheAdapterOptions) {
    this.client = options.client;
    this.prefix = options.prefix ?? "app";
    this.defaultTtlSeconds = options.defaultTtlSeconds ?? DEFAULT_CACHE_TTL_SECONDS;
    this.logger = options.logger;
    this.metrics = options.metrics;
    this.pingFn = options.ping ?? (async () => {
      await this.client.ping();
    });
  }

  private async getVersion(namespace: string): Promise<number> {
    const rawVersion = await this.client.get(buildNamespaceVersionKey(this.prefix, namespace));
    if (rawVersion === null) {
      return 0;
    }
    const parsed = Number.parseInt(rawVersion, 10);
    return Number.isNaN(parsed) ? 0 : parsed;
  }

  async get<T>(namespace: string, key: string): Promise<T | undefined> {
    try {
      const version = await this.getVersion(namespace);
      const raw = await this.client.get(buildCacheKey(this.prefix, namespace, version, key));
      if (raw === null) {
        this.metrics?.recordCacheOp({ operation: "get", result: "miss" });
        return undefined;
      }

      const decoded = deserializeCacheValue<T>(raw);
      if (!decoded.hit) {
        this.metrics?.recordCacheOp({ operation: "get", result: "miss" });
        return undefined;
      }

      this.metrics?.recordCacheOp({ operation: "get", result: "hit" });
      return decoded.value;
    }
    catch (err) {
      this.logger.warn({ err, operation: "get", namespace, key }, "Redis cache error; failing open");
      this.metrics?.recordCacheOp({ operation: "get", result: "error" });
      return undefined;
    }
  }

  async set<T>(
    namespace: string,
    key: string,
    value: T,
    ttlSeconds = this.defaultTtlSeconds,
  ): Promise<void> {
    try {
      const version = await this.getVersion(namespace);
      const fullKey = buildCacheKey(this.prefix, namespace, version, key);
      const payload = serializeCacheValue(value);

      if (payload === null || ttlSeconds <= 0) {
        await this.client.del(fullKey);
        this.metrics?.recordCacheOp({ operation: "set", result: "ok" });
        return;
      }

      await this.client.set(fullKey, payload, "EX", Math.ceil(ttlSeconds));
      this.metrics?.recordCacheOp({ operation: "set", result: "ok" });
    }
    catch (err) {
      this.logger.warn({ err, operation: "set", namespace, key }, "Redis cache error; failing open");
      this.metrics?.recordCacheOp({ operation: "set", result: "error" });
    }
  }

  async del(namespace: string, key: string): Promise<void> {
    try {
      const version = await this.getVersion(namespace);
      await this.client.del(buildCacheKey(this.prefix, namespace, version, key));
      this.metrics?.recordCacheOp({ operation: "del", result: "ok" });
    }
    catch (err) {
      this.logger.warn({ err, operation: "del", namespace, key }, "Redis cache error; failing open");
      this.metrics?.recordCacheOp({ operation: "del", result: "error" });
    }
  }

  async getOrSet<T>(
    namespace: string,
    key: string,
    loader: () => Promise<T>,
    ttlSeconds = this.defaultTtlSeconds,
  ): Promise<T> {
    const cached = await this.get<T>(namespace, key);
    if (cached !== undefined) {
      return cached;
    }

    const value = await loader();
    if (value !== undefined) {
      await this.set(namespace, key, value, ttlSeconds);
    }
    return value;
  }

  async invalidateNamespace(namespace: string): Promise<void> {
    try {
      await this.client.incr(buildNamespaceVersionKey(this.prefix, namespace));
      this.metrics?.recordCacheOp({ operation: "invalidate", result: "ok" });
    }
    catch (err) {
      this.logger.warn({ err, operation: "invalidate", namespace }, "Redis cache error; failing open");
      this.metrics?.recordCacheOp({ operation: "invalidate", result: "error" });
    }
  }

  async ping(): Promise<void> {
    await this.pingFn();
  }

  scoped(namespace: string): ScopedCache {
    return createScopedCache(this, namespace);
  }
}
