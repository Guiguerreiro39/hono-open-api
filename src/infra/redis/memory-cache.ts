import type { CachePort, ScopedCache } from "@/core/ports/cache";
import type { MetricsPort } from "@/core/ports/metrics";
import { DEFAULT_CACHE_TTL_SECONDS } from "@/core/ports/cache";

import {
  buildCacheKey,
  createScopedCache,
  deserializeCacheValue,
  serializeCacheValue,
} from "./cache-utils";

export const DEFAULT_MEMORY_CACHE_MAX_ENTRIES = 1000;

interface MemoryCacheEntry {
  payload: string;
  expiresAt: number;
}

export interface MemoryCacheAdapterOptions {
  prefix?: string;
  maxEntries?: number;
  defaultTtlSeconds?: number;
  metrics?: MetricsPort;
}

export class MemoryCacheAdapter implements CachePort {
  readonly prefix: string;
  readonly maxEntries: number;
  readonly defaultTtlSeconds: number;

  private readonly metrics?: MetricsPort;
  private readonly entries = new Map<string, MemoryCacheEntry>();
  private readonly versions = new Map<string, number>();

  constructor(options?: MemoryCacheAdapterOptions) {
    this.prefix = options?.prefix ?? "app";
    this.maxEntries = options?.maxEntries ?? DEFAULT_MEMORY_CACHE_MAX_ENTRIES;
    this.defaultTtlSeconds = options?.defaultTtlSeconds ?? DEFAULT_CACHE_TTL_SECONDS;
    this.metrics = options?.metrics;
  }

  private getVersion(namespace: string): number {
    return this.versions.get(namespace) ?? 0;
  }

  private purgeExpired(now: number): void {
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) {
        this.entries.delete(key);
      }
    }
  }

  async get<T>(namespace: string, key: string): Promise<T | undefined> {
    const fullKey = buildCacheKey(this.prefix, namespace, this.getVersion(namespace), key);
    const entry = this.entries.get(fullKey);
    if (!entry) {
      this.metrics?.recordCacheOp({ operation: "get", result: "miss" });
      return undefined;
    }

    if (entry.expiresAt <= Date.now()) {
      this.entries.delete(fullKey);
      this.metrics?.recordCacheOp({ operation: "get", result: "miss" });
      return undefined;
    }

    const decoded = deserializeCacheValue<T>(entry.payload);
    if (!decoded.hit) {
      this.entries.delete(fullKey);
      this.metrics?.recordCacheOp({ operation: "get", result: "miss" });
      return undefined;
    }

    this.metrics?.recordCacheOp({ operation: "get", result: "hit" });
    return decoded.value;
  }

  async set<T>(
    namespace: string,
    key: string,
    value: T,
    ttlSeconds = this.defaultTtlSeconds,
  ): Promise<void> {
    const fullKey = buildCacheKey(this.prefix, namespace, this.getVersion(namespace), key);
    const payload = serializeCacheValue(value);

    if (payload === null || ttlSeconds <= 0) {
      this.entries.delete(fullKey);
      this.metrics?.recordCacheOp({ operation: "set", result: "ok" });
      return;
    }

    const now = Date.now();
    this.entries.delete(fullKey);

    if (this.entries.size >= this.maxEntries) {
      this.purgeExpired(now);
      while (this.entries.size >= this.maxEntries) {
        const oldestKey = this.entries.keys().next().value;
        if (oldestKey === undefined) {
          break;
        }
        this.entries.delete(oldestKey);
      }
    }

    this.entries.set(fullKey, {
      payload,
      expiresAt: now + ttlSeconds * 1000,
    });
    this.metrics?.recordCacheOp({ operation: "set", result: "ok" });
  }

  async del(namespace: string, key: string): Promise<void> {
    const fullKey = buildCacheKey(this.prefix, namespace, this.getVersion(namespace), key);
    this.entries.delete(fullKey);
    this.metrics?.recordCacheOp({ operation: "del", result: "ok" });
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
    this.versions.set(namespace, this.getVersion(namespace) + 1);
    this.metrics?.recordCacheOp({ operation: "invalidate", result: "ok" });
  }

  async ping(): Promise<void> {}

  scoped(namespace: string): ScopedCache {
    return createScopedCache(this, namespace);
  }

  clear(): void {
    this.entries.clear();
    this.versions.clear();
  }
}
