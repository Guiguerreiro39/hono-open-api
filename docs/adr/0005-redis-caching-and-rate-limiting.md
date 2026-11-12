---
status: accepted
---

# Redis connectivity, caching strategy, and rate-limiting policy

We require `REDIS_URL` strictly in `production` while keeping it optional in `development` and `test` for zero-dependency in-memory `Adapter` fallbacks, encapsulate `ioredis` inside `src/infra/redis/` behind a narrow `CachePort` (`src/core/ports/cache.ts`) and `RateLimiterPort` (`src/core/ports/rate-limit.ts`), disable Better Auth's built-in `rateLimit` so `hono-rate-limiter` (`draft-7` headers + `RateLimitError` `429`) governs both `/api/auth/*` and `/api/v1/*` uniformly, and apply strict fail-open resilience for cache and rate-limit Redis failures.

## Considered Options

- **Expose a generic `RedisPort` (`get`/`set`/`incr`/`evalsha`) to `Core` and `Feature Module`s**: Rejected because leaking raw Redis commands widens the `Port` surface, couples callers to Redis semantics, and forces modules to duplicate key prefixing, JSON null-vs-miss handling, and fail-open wrappers.
- **Redis `SCAN`-based prefix deletion (`delByPrefix`) and background TTL sweep timers in memory**: Rejected because `SCAN` is `O(N)` over the keyspace and `setInterval` sweepers leak active handles across Vitest runs; O(1) namespace version keys (`_ns:<namespace>`) and lazy TTL expiry on read with bounded `maxEntries` eviction avoid both issues.
- **Custom Lua sliding-window rate limiter and dual Better Auth + Hono rate limiting**: Rejected because `hono-rate-limiter` (`MemoryStore` + 4-method `ioredis` `RedisStore` adapter) handles fixed-window `draft-7` headers without maintaining custom Lua scripts, while leaving Better Auth's native `rateLimit` enabled alongside Hono would double-count requests and emit inconsistent `429` payloads.
- **Make `REDIS_URL` optional in `production` or fail closed (`503`) on Redis errors**: Rejected because silently falling back to per-process memory in multi-instance production breaks shared rate limits and cache consistency, while failing closed on cache or rate-limit blips sacrifices API availability.

## Consequences

- `src/env.ts` validates `REDIS_URL` (`redis://` / `rediss://`) and requires it when `NODE_ENV=production`, adds optional `CACHE_PREFIX` (default `"app"`), `TRUST_PROXY` (default `false`), and `RATE_LIMIT_ENABLED` (default `false` in `test`, `true` otherwise).
- `src/infra/redis/` owns the `ioredis` client factory (mandatory `.on("error")` listeners, non-blocking connect, exponential reconnect backoff, `ping()` health probe, `quit()` shutdown, fail-fast `enableOfflineQueue: false` + `maxRetriesPerRequest: 2` for API commands, leaving `pub`/`sub` and BullMQ `maxRetriesPerRequest: null` workers isolated inside `Infra`).
- `CachePort` (`get`, `set`, `del`, `getOrSet`, `invalidateNamespace`, `ping`, plus `scoped(ns)`) uses `${CACHE_PREFIX}:${namespace}:v${version}:${key}` keys, a JSON wrapper distinguishing cached `null` from a miss, `300s` default TTL, `MemoryCacheAdapter` (`maxEntries: 1000`, lazy expiry, `clear()`), and `RedisCacheAdapter` (fail-open with Pino `warn`), contract-tested in `PlatformDeps` without caching `tasks` CRUD yet.
- `RateLimiterPort` / `createRateLimiter(...)` isolates tier buckets via `rl:<tier>:`, keys by `user:${user.id}` after `requireAuth` in Feature Modules or IP via `conninfo` (`X-Forwarded-For`/`X-Real-IP` only when `TRUST_PROXY=true`), fails open on Redis errors, and enforces `10 req/min` on auth mutations (`/api/auth/sign-in/*`, `/api/auth/sign-up/*`, password reset) and uploads (`POST /api/v1/files`), `100 req/min` on general `/api/v1/*` and non-mutation `/api/auth/*`, and exempts `/health`, `/ready`, `/metrics`, `/doc`, `/reference`, and `/api/auth/open-api/generate-schema`.
