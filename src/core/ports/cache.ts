export const DEFAULT_CACHE_TTL_SECONDS = 300;

export interface ScopedCache {
  get: <T>(key: string) => Promise<T | undefined>;
  set: <T>(key: string, value: T, ttlSeconds?: number) => Promise<void>;
  del: (key: string) => Promise<void>;
  getOrSet: <T>(key: string, loader: () => Promise<T>, ttlSeconds?: number) => Promise<T>;
  invalidate: () => Promise<void>;
}

export interface CachePort {
  get: <T>(namespace: string, key: string) => Promise<T | undefined>;
  set: <T>(namespace: string, key: string, value: T, ttlSeconds?: number) => Promise<void>;
  del: (namespace: string, key: string) => Promise<void>;
  getOrSet: <T>(namespace: string, key: string, loader: () => Promise<T>, ttlSeconds?: number) => Promise<T>;
  invalidateNamespace: (namespace: string) => Promise<void>;
  ping: () => Promise<void>;
  scoped: (namespace: string) => ScopedCache;
}
