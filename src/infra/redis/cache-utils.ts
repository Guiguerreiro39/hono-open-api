import type { CachePort, ScopedCache } from "@/core/ports/cache";

export function buildNamespaceVersionKey(prefix: string, namespace: string): string {
  return `${prefix}:_ns:${namespace}`;
}

export function buildCacheKey(
  prefix: string,
  namespace: string,
  version: number,
  key: string,
): string {
  return `${prefix}:${namespace}:v${version}:${key}`;
}

export function serializeCacheValue<T>(value: T): string | null {
  if (value === undefined) {
    return null;
  }
  return JSON.stringify({ v: value });
}

export function deserializeCacheValue<T>(
  raw: string,
): { hit: true; value: T } | { hit: false } {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === "object" && parsed !== null && Object.hasOwn(parsed, "v")) {
      return { hit: true, value: (parsed as { v: T }).v };
    }
    return { hit: false };
  }
  catch {
    return { hit: false };
  }
}

export function createScopedCache(cache: CachePort, namespace: string): ScopedCache {
  return {
    get: key => cache.get(namespace, key),
    set: (key, value, ttlSeconds) => cache.set(namespace, key, value, ttlSeconds),
    del: key => cache.del(namespace, key),
    getOrSet: (key, loader, ttlSeconds) => cache.getOrSet(namespace, key, loader, ttlSeconds),
    invalidate: () => cache.invalidateNamespace(namespace),
  };
}
