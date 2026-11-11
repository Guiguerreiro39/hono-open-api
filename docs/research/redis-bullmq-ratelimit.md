# Redis Client, BullMQ Queues/Cron, and Hono Rate-Limiting Research

**Repository Context:** `Guiguerreiro39/hono-open-api` (`hono-open-api-starter`) — Node.js ESM (`"type": "module"`), TypeScript `~5.9.3` (`"module": "ESNext"`, `"moduleResolution": "Bundler"`, `"strict": true`), Hono `^4.12.32` with `@hono/node-server` `^2.0.12` and `@hono/zod-openapi` `^1.5.1`, Vitest `^4.1.10`.

---

## Executive Summary & Recommendations

| Concern | Recommended Choice | Key Rationale |
|---|---|---|
| **Redis client** | **`ioredis` (`>=5.x` / `6.x`)** | Native first-party TypeScript types, zero-adapter support across BullMQ v5 and v6, direct `client.call()` support for Lua/rate-limit stores, predictable `await client.quit()` shutdown, clean `import { Redis } from "ioredis"` under `moduleResolution: "Bundler"`. |
| **Pub/Sub scaling** | **Dedicated `pub` + `sub = pub.duplicate()` bridging local `EventEmitter`** | Under RESP2 (still default in `ioredis` v5 and `node-redis` v4/v5), `SUBSCRIBE` puts a socket into subscriber mode where regular commands fail. Maintaining one shared `sub` connection per process avoids per-SSE-client Redis sockets. |
| **Background jobs & cron** | **BullMQ (`upsertJobScheduler` + `worker.close()`) behind a `QueuePort` seam** | `repeat` APIs were deprecated in BullMQ v5.16.0 and removed in v6.0.0; use `upsertJobScheduler`. Isolate Workers on `maxRetriesPerRequest: null` (blocking commands), keep API `Queue` producers fail-fast (`enableOfflineQueue: false`), and wrap behind an adapter with an in-memory sync driver for Vitest/dev. |
| **HTTP rate limiting** | **`hono-rate-limiter` (v0.5.4) with `RedisStore` adapter or custom Sliding-Window `Store`** | `@hono-rate-limiter/redis` merged into `hono-rate-limiter` in v0.5.0. Note `hono-rate-limiter`'s `RedisStore` expects an Upstash-shaped `RedisClient` (`scriptLoad` / `evalsha(sha, keys[], args[])`), so `ioredis` requires a 4-method wrapper (or `rate-limit-redis` / custom `Store` for sliding windows). Emit `draft-7` (or `draft-6`) + `Retry-After` on `429`. |

---

## 1. Local Codebase Alignment

Inspecting the repository establishes the exact integration constraints:

- **Module & TypeScript configuration** ([`package.json`](../../package.json), [`tsconfig.json`](../../tsconfig.json)): `"type": "module"` with `"target": "ESNext"`, `"module": "ESNext"`, `"moduleResolution": "Bundler"`, path alias `@/* -> ./src/*`, compiled via `tsc && tsc-alias`. Both named ESM imports and CJS-compiled packages with `.d.ts` declarations resolve cleanly.
- **Environment validation & lint rules** ([`src/env.ts`](../../src/env.ts), [`eslint.config.mjs`](../../eslint.config.mjs)): `"node/no-process-env": ["error"]` forbids direct `process.env` reads outside `src/env.ts`. New Redis/queue configuration (`REDIS_URL`, optional queue driver/rate-limit toggles) must live in `EnvSchema` (`zod`) with `NODE_ENV === "production"` refinements in `src/env.ts`. Files follow `kebabCase` (`unicorn/filename-case`).
- **Realtime Pub/Sub & SSE** ([`src/lib/realtime/pubsub.ts`](../../src/lib/realtime/pubsub.ts), [`src/lib/realtime/sse.ts`](../../src/lib/realtime/sse.ts)): `PubSubManager` currently wraps a single-process `EventEmitter` (`publish<T>(topic, event)`, `subscribe<T>(topic, listener) => () => void`). `createLiveQueryStream` subscribes per SSE connection and tears down via `unsub()` on `stream.onAbort`. Scaling horizontally requires backing `PubSubManager` with Redis Pub/Sub while keeping local fan-out in-memory.
- **Hono app & server lifecycle** ([`src/index.ts`](../../src/index.ts), [`src/lib/types.ts`](../../src/lib/types.ts)): `serve({ fetch: app.fetch, port })` currently starts `@hono/node-server` without `SIGINT`/`SIGTERM` handlers. Adding Redis, BullMQ workers, or rate-limit stores requires wiring graceful shutdown (`server.close()`, `worker.close()`, `queue.close()`, Redis `quit()`/`close()`). Route bindings use `OpenAPIHono<AppBindings>` with `c.get("user")` populated by `requireAuth` (`src/middlewares/auth.ts`).
- **Test runner** ([`vitest.config.ts`](../../vitest.config.ts)): Vitest runs with `fileParallelism: false` and `@` alias resolution; an in-memory queue/store driver keeps unit and route tests fast without requiring a running Redis instance.

---

## 2. Redis Client Comparison: `ioredis` vs `redis` (`node-redis` v4/v5)

### Comparison Matrix

| Dimension | `ioredis` (`v5.x` / `v6.0.0`) | `redis` / `node-redis` (`v4` / `v5`) |
|---|---|---|
| **Module format & TS** | Compiled to CJS (`"main": "./built/index.js"`, no `"exports"` field); first-party `.d.ts` built in (`package.json`, `tsconfig.json`). Use `import { Redis } from "ioredis"` (default import deprecated in future major per README). | Monorepo (`redis` + `@redis/client`) with package `"exports"` maps and built-in TypeScript types (`README.md`, `packages/redis/package.json`). |
| **Node.js & RESP default** | `v5`: Node `>=12`, RESP2 default. `v6.0.0`: requires **Node `>=20.0.0`**, switches default to **RESP3** (`protocol: 3`, `replyMapping: "legacy"`; pass `protocol: 2` for RESP2) (`CHANGELOG.md`, `RedisOptions.ts`). | `v5`: defaults to **RESP2** (`RESP: 2`) unless `RESP: 3` is passed; `v6` moves default to RESP3 (`docs/RESP.md`, `docs/pub-sub.md`). |
| **Connection init** | Connects automatically in `new Redis()` (unless `lazyConnect: true`) (`lib/Redis.ts`). | Requires explicit `await client.connect()` after `createClient()`. |
| **Pub/Sub dedicated connection** | Required (`sub = pub.duplicate()`). Auto-resubscribes on reconnect (`autoResubscribe: true`). `silentEmit` logs unhandled errors if no listener (`README.md`, `lib/Redis.ts`). | Required under RESP2 (`sub = client.duplicate()`, then `await sub.connect()`). Auto-resubscribes before `'ready'`. **Must** attach `sub.on("error", ...)` or unhandled `'error'` crashes Node (`docs/pub-sub.md`, `socket.ts`). |
| **BullMQ compatibility** | Native first-class client across BullMQ v5 and v6 (`package.json`, `docs/connections.md`). | **Not supported in BullMQ v5.** Supported in **BullMQ v6** only for `redis >= 5.0.0` via `createNodeRedisClient(raw)` / `RedisConnection.clientFactory` (`docs/connections.md`). |
| **TLS & Auth** | `rediss://user:pass@host:port/db` or `{ username, password, tls: { ca, cert, rejectUnauthorized } }`. Pitfall: `options.host` must be hostname only, never a `rediss://` URL (`README.md`). | `url: "rediss://user:pass@host:port/db"` or `{ username, password, socket: { tls: true, servername, ca, cert } }`. Cluster pitfall: put auth/TLS in `defaults`, not only `rootNodes` (`docs/client-configuration.md`, `docs/clustering.md`). |
| **Graceful shutdown** | `await client.quit()` (sends `QUIT`, waits for pending replies); `client.disconnect()` closes immediately (`end()` deprecated) (`lib/Redis.ts`). | **v4:** `await client.quit()` / `await client.disconnect()`. **v5:** `quit()` and `disconnect()` are `@deprecated` (following Redis 7.2 deprecating `QUIT`); use **`await client.close()`** (drains queue) and **`client.destroy()`** (sync immediate teardown) (`README.md`, `client/index.ts`). |

### Key Details

1. **Node.js ESM + TypeScript (`moduleResolution: "Bundler"`)**:
   - In `ioredis` (`lib/index.ts`), both `default` and named `{ Redis, Cluster }` are exported alongside `module.exports`. The official README notes `import { Redis } from "ioredis"` is preferred for TypeScript and warns that `import Redis from "ioredis"` will be deprecated in a future major (`https://github.com/redis/ioredis/blob/main/README.md`, `https://github.com/redis/ioredis/blob/main/lib/index.ts`).
   - In `node-redis` v5, `createClient` uses native `exports` maps and TypeScript proxy methods (`.withTypeMapping()`, `.withCommandOptions()`, `.withAbortSignal()` replacing v4's per-command `commandOptions(...)`, and `.legacy()` replacing `{ legacyMode: true }`) (`https://github.com/redis/node-redis/blob/master/packages/client/lib/client/index.ts`, `https://github.com/redis/node-redis/blob/master/docs/command-options.md`).

2. **Redis Pub/Sub & Dedicated Subscriber Connection**:
   - Under RESP2, calling `SUBSCRIBE` / `PSUBSCRIBE` switches the Redis connection into subscriber mode; only subscription commands (`SUBSCRIBE`, `PSUBSCRIBE`, `UNSUBSCRIBE`, `PUNSUBSCRIBE`, `SSUBSCRIBE`, `SUNSUBSCRIBE`, `PING`, `QUIT`) are allowed (`https://github.com/redis/ioredis/blob/main/README.md`, `https://github.com/redis/node-redis/blob/master/docs/pub-sub.md`). Attempting `PUBLISH` or `GET` on that connection fails.
   - Although RESP3 enables out-of-band push frames (`>`) on a shared connection (`https://github.com/redis/node-redis/blob/master/docs/RESP.md`), maintaining a dedicated subscriber connection (`const sub = pub.duplicate()`) remains standard practice to isolate Pub/Sub traffic from command head-of-line blocking and preserve RESP2 compatibility.
   - **Reconnect & error-listener trap**: Both `ioredis` (`autoResubscribe: true`, `https://github.com/redis/ioredis/blob/main/README.md`) and `node-redis` (`#queue.resubscribe()` before `'ready'`, `https://github.com/redis/node-redis/blob/master/packages/client/lib/client/index.ts`) automatically restore subscriptions on reconnect. However, `.duplicate()` does **not** copy event listeners—attach `"error"` handlers to **both** `pub` and `sub` (`https://github.com/redis/node-redis/blob/master/docs/pub-sub.md`).
   - **Fitting `src/lib/realtime/pubsub.ts`**: Calling `node-redis`'s `sub.subscribe(channel, fn)` multiple times registers duplicate callbacks on the client (`https://github.com/redis/node-redis/blob/master/docs/pub-sub.md`). Bridging Redis `sub` into a process-local `EventEmitter` (and issuing Redis `SUBSCRIBE` / `UNSUBSCRIBE` only when local listener counts transition `0 <-> 1`) keeps one Redis subscription per topic regardless of how many SSE tabs connect via `createLiveQueryStream`.

3. **Graceful Shutdown Semantics**:
   - **`ioredis`**: `await client.quit()` sends `QUIT`, drains in-flight replies, and prevents reconnect (`manuallyClosing` semantics); `client.disconnect()` cuts the socket immediately and may drop pending replies (`https://github.com/redis/ioredis/blob/main/lib/Redis.ts`).
   - **`node-redis` v4 vs v5**: Redis 7.2 deprecated `QUIT`, so `node-redis` v5 deprecated `client.quit()`/`QUIT()` and `client.disconnect()`. In `node-redis` v5, call `await client.close()` (drains `#queue` and resolves `Promise<void>`) for graceful shutdown, or synchronous `client.destroy()` (flushes queue with `DisconnectsClientError` and tears down the socket) for forced shutdown (`https://github.com/redis/node-redis/blob/master/packages/client/lib/client/index.ts`, `https://github.com/redis/node-redis/blob/master/packages/client/lib/client/socket.ts`).

---

## 3. BullMQ (`bullmq`) Requirements & Patterns

### 3.1 Why `maxRetriesPerRequest: null` Is Required for Workers

- By default, `ioredis` sets `maxRetriesPerRequest: 20` (`https://github.com/redis/ioredis/blob/main/docs/interfaces/CommonRedisOptions.html`). If Redis disconnects, `ioredis` flushes queued/unfulfilled commands with `MaxRetriesPerRequestError` every `maxRetriesPerRequest + 1` reconnect attempts (`https://github.com/redis/ioredis/blob/main/lib/redis/event_handler.ts`).
- BullMQ `Worker` (and `QueueEvents`) maintain long-lived **blocking Redis commands** to wait for incoming jobs. If Redis drops temporarily during rolling deploys or network blips, a finite `maxRetriesPerRequest` throws `MaxRetriesPerRequestError` and breaks the worker loop (`https://docs.bullmq.io/guide/going-to-production`, `https://docs.bullmq.io/guide/connections`).
- Setting `maxRetriesPerRequest: null` disables the retry cap so blocking commands wait indefinitely until Redis reconnects (`https://github.com/redis/ioredis/blob/main/README.md`). BullMQ's `Worker` sets `blockingConnection: true` internally (`https://github.com/taskforcesh/bullmq/blob/master/src/classes/worker.ts`) and warns/overrides in `src/classes/redis-connection.ts` if a passed `ioredis` instance or option sets a non-null value.
- **API Producers (`Queue`) should fail fast**: Unlike workers, Hono HTTP handlers calling `queue.add()` should **not** hang indefinitely when Redis is down. BullMQ's *Failing fast when Redis is down* pattern uses separate producer connection options with `enableOfflineQueue: false` (and bounded `maxRetriesPerRequest`) so `queue.add()` rejects immediately and the route can return `503` (note: Redis must still be reachable when `Queue` is instantiated) (`https://github.com/taskforcesh/bullmq/blob/master/docs/gitbook/patterns/failing-fast-when-redis-is-down.md`).

### 3.2 Connection Sharing vs Separate Blocking Connections

- Passing a single `ioredis` instance (configured with `maxRetriesPerRequest: null`) to multiple `Queue` and `Worker` constructors is supported for convenience (`https://docs.bullmq.io/guide/connections`).
- However, `Worker` (and `QueueEvents`) **never** run blocking commands on that shared client directly: `src/classes/worker.ts` calls `.duplicate({ connectionName })` to open a dedicated blocking connection (`{ shared: false, blocking: true }`) per instance (`https://github.com/taskforcesh/bullmq/blob/master/src/classes/worker.ts`).
- **Operational implications**:
  1. Every custom `IRedisClient` adapter (or `createNodeRedisClient` wrapper in BullMQ v6) must support `duplicate()` (`https://docs.bullmq.io/guide/connections`).
  2. Total Redis connections scale as `shared non-blocking connections + (number of Workers) + (number of QueueEvents)`—plan against Redis connection limits (e.g., managed Redis/Upstash caps).
  3. Prefer **two distinct connection configs**: a fail-fast non-blocking `Queue` connection (`enableOfflineQueue: false`, default `maxRetriesPerRequest`) for the API process, and a `maxRetriesPerRequest: null` base connection shared across `Worker`s (each duplicating its own blocking connection).

### 3.3 Cron / Repeatable Jobs: `upsertJobScheduler` vs Deprecated `repeat`

- Legacy repeatable APIs (`Queue.add(..., { repeat })`, `Queue.addBulk(..., { repeat })`, `Repeat`, `getRepeatableJobs()`, `removeRepeatable()`, `removeRepeatableByKey()`) were **deprecated in BullMQ v5.16.0** and **completely removed in BullMQ v6.0.0** (`https://github.com/taskforcesh/bullmq/blob/master/docs/gitbook/guide/jobs/repeatable.md`, `https://github.com/taskforcesh/bullmq/blob/master/docs/gitbook/changelog.md`).
- Use **Job Schedulers** (`upsertJobScheduler`, `getJobSchedulers`, `removeJobScheduler`):
  - `await queue.upsertJobScheduler(schedulerId, repeatOpts, jobTemplate)` is **idempotent** by `schedulerId` (`https://github.com/taskforcesh/bullmq/blob/master/docs/gitbook/guide/job-schedulers/README.md`).
  - `repeatOpts` supports `{ pattern, every, limit, startDate, endDate, tz }`. Legacy `repeat.utc: true` maps to `{ tz: "UTC" }`, and the `immediately` option was deprecated in v5.19.0 (`https://github.com/taskforcesh/bullmq/blob/master/docs/gitbook/guide/migrations/migrate-from-v5-to-v6.md`, `https://github.com/taskforcesh/bullmq/blob/master/docs/gitbook/guide/job-schedulers/repeat-options.md`).

```typescript
await queue.upsertJobScheduler(
  "daily-cleanup",
  { pattern: "0 15 3 * * *", tz: "UTC" },
  {
    name: "cleanup-expired",
    data: { batchSize: 500 },
    opts: { attempts: 3, backoff: { type: "exponential", delay: 1000 } },
  },
);
```

### 3.4 Graceful Worker Shutdown (`worker.close()`)

- Calling `await worker.close()` (default `force = false`) in `Worker` (`https://github.com/taskforcesh/bullmq/blob/master/src/classes/worker.ts`, `https://docs.bullmq.io/guide/workers/graceful-shutdown`):
  1. Sets `this.closing` (prevents fetching new jobs) and aborts `abortDelayController` (waking idle long-poll `drainDelay`, default `5` s).
  2. Waits for all active in-flight jobs to finish (`whenCurrentJobsFinished(false)`)—unless `force = true`.
  3. Closes `lockManager`, cleans sandboxed `childPool`, closes `backend` (and duplicated Redis sockets), and stops stalled-job checks.
- **Signal handling order** in `src/index.ts`: listen for `SIGINT` and `SIGTERM`, stop accepting new HTTP traffic (`server.close()`), `await worker.close()`, `await queue.close()`, close Pub/Sub & rate-limit Redis clients (`await redis.quit()`), then exit (`https://docs.bullmq.io/guide/going-to-production`).
- **Timeout & stalled-job caveat**: In TypeScript, `worker.close()` waits indefinitely for active jobs (`https://docs.bullmq.io/guide/workers/graceful-shutdown`). Ensure container `terminationGracePeriodSeconds` exceeds maximum job duration (or race with a shutdown timeout calling `worker.close(true)`). Jobs interrupted before completion remain locked until `lockDuration` (default `30000` ms) expires and are recovered by `stalledInterval` (default `30000` ms) up to `maxStalledCount` (default `1`) (`https://github.com/taskforcesh/bullmq/blob/master/src/interfaces/worker-options.ts`).

### 3.5 Wrapping BullMQ Behind an Adapter Seam with an In-Memory / Sync Driver

To prevent `bullmq` types from leaking into Hono routes/services and to keep Vitest fast without Redis:

```typescript
export interface QueueScheduleOptions {
  pattern?: string;
  every?: number;
  tz?: string;
}

export interface JobOptions {
  delayMs?: number;
  attempts?: number;
  jobId?: string;
}

export interface QueuePort<TMap extends Record<string, unknown>> {
  enqueue: <K extends keyof TMap & string>(
    name: K,
    data: TMap[K],
    opts?: JobOptions,
  ) => Promise<string>;
  registerHandler: <K extends keyof TMap & string>(
    name: K,
    handler: (data: TMap[K]) => Promise<void>,
  ) => void;
  upsertSchedule: <K extends keyof TMap & string>(
    schedulerId: string,
    schedule: QueueScheduleOptions,
    template: { name: K; data: TMap[K]; opts?: JobOptions },
  ) => Promise<void>;
  removeSchedule: (schedulerId: string) => Promise<boolean>;
  close: () => Promise<void>;
}
```

- **Production (`BullMQQueueAdapter`)**: Wraps a `Queue` (fail-fast connection), a single `Worker` routing `job.name` to registered handlers (`maxRetriesPerRequest: null` connection), `upsertJobScheduler` / `removeJobScheduler`, and ordered `await worker.close()` + `await queue.close()`.
- **Dev / Vitest (`MemorySyncQueueAdapter`)**: Stores registered handlers and schedules in `Map`s. `enqueue()` either executes the handler inline (`await handler(data)`) or pushes to an in-memory queue with an explicit `drain()` helper for deterministic test assertions.
- **Explicit fidelity boundary**: In-memory sync drivers do **not** test JSON serialization round-trips, Redis `lockDuration`/stalled-job recovery, exponential backoff across process restarts, cross-process worker concurrency, or real cron timer triggers. Pair with a small Redis-backed integration smoke suite in CI when Redis is available.

---

## 4. Hono Rate-Limiting Options & Standard Headers

### 4.1 `hono-rate-limiter` (v0.5.4) and Redis Stores

- **Package consolidation**: `@hono-rate-limiter/redis` was merged back into `hono-rate-limiter` in v0.5.0; current `hono-rate-limiter` (v0.5.4) exports `rateLimiter`, `MemoryStore`, `RedisStore`, and `UnstorageStore` from `"hono-rate-limiter"` with zero runtime dependencies and peer dependency `hono ^4.10.8` (`https://github.com/rhinobase/hono-rate-limiter/blob/main/_autodocs/api-reference/index.md`).
- **How `RedisStore` works**:
  - Executes atomic server-side Lua scripts via `SCRIPT LOAD` + `EVALSHA` (retrying once after reloading on `NOSCRIPT`) (`https://github.com/rhinobase/hono-rate-limiter/blob/main/_autodocs/api-reference/RedisStore.md`).
  - `increment` script runs `INCR` + `PTTL` and calls `PEXPIRE` with `windowMs` when `timeToExpire <= 0` or `resetExpiryOnChange === true` (`https://github.com/rhinobase/hono-rate-limiter/blob/main/_autodocs/api-reference/RedisStore.md`).
  - With default `resetExpiryOnChange: false`, this is a **fixed-window** counter. Setting `resetExpiryOnChange: true` creates an idle-reset penalty window (resets TTL on every request), **not** a sliding window.
- **Important `RedisClient` contract caveat (docs vs source)**:
  - Although `_autodocs/api-reference/RedisStore.md` shows `new RedisStore({ client })` directly with `ioredis`, `src/stores/redis/types.ts` defines `RedisClient` with an `@upstash/redis`-style signature (`https://github.com/rhinobase/hono-rate-limiter/blob/main/_autodocs/types.md`):
    ```typescript
    export interface RedisClient {
      scriptLoad: (script: string) => Promise<string>;
      evalsha: <TArgs extends unknown[], TData = unknown>(
        sha1: string,
        keys: string[],
        args: TArgs,
      ) => Promise<TData>;
      decr: (key: string) => Promise<number>;
      del: (key: string) => Promise<number>;
    }
    ```
  - `ioredis` exposes `script("LOAD", s)` and `evalsha(sha, numkeys, ...keys, ...args)` (`https://github.com/redis/ioredis/blob/main/lib/utils/RedisCommander.ts`), and `node-redis` uses `evalSha(sha, { keys, arguments })`. Passing a raw `ioredis` or `node-redis` client without a 4-method adapter breaks the `RedisClient` contract:
    ```typescript
    import type { RedisClient } from "hono-rate-limiter";
    import type { Redis } from "ioredis";

    export function toHonoRateLimiterClient(redis: Redis): RedisClient {
      return {
        scriptLoad: script => redis.script("LOAD", script) as Promise<string>,
        evalsha: <TArgs extends unknown[], TData = unknown>(
          sha1: string,
          keys: string[],
          args: TArgs,
        ) =>
          redis.evalsha(
            sha1,
            keys.length,
            ...keys,
            ...(args as Array<string | number | Buffer>),
          ) as Promise<TData>,
        decr: key => redis.decr(key),
        del: key => redis.del(key),
      };
    }
    ```
  - Alternative pre-built store: `rate-limit-redis` wraps `sendCommand: (...args) => redis.call(...args)` for `ioredis` or `client.sendCommand(args)` for `node-redis`, though it requires casting to `hono-rate-limiter`'s `Store` type.
- **Hono integration & key generation**:
  - `rateLimiter<AppBindings>(...)` integrates cleanly with `OpenAPIHono<AppBindings>` (`src/lib/types.ts`) and supports `MemoryStore` in tests/dev and `RedisStore` in production (`https://github.com/rhinobase/hono-rate-limiter/blob/main/_autodocs/configuration.md`).
  - Use `c.get("user")?.id` on authenticated routes (`/tasks/*`, `/users/*`). For unauthenticated routes (`/auth/*`), only trust `x-forwarded-for` / `x-real-ip` when behind a verified reverse proxy that overwrites or strips client-supplied headers; otherwise clients can spoof `x-forwarded-for` to bypass limits.

### 4.2 Custom Fixed-Window vs Sliding-Window Redis Limiters

If boundary bursts (up to `2x` limit across adjacent fixed-window edges) are unacceptable, implement `hono-rate-limiter`'s `Store` interface (`increment`, `decrement`, `resetKey`, `get`) or a custom `MiddlewareHandler<AppBindings>`:

| Algorithm | Redis Structures & Commands | Memory / Cost | Accuracy & Trade-offs |
|---|---|---|---|
| **Fixed Window** (`RedisStore` default) | 1 string key; Lua `INCR` + `PTTL` + `PEXPIRE` | `O(1)` per key, 1 RTT | Simple, fast; permits up to `2x` burst across window boundary. |
| **Sliding Window Log** | 1 ZSET key; Lua `TIME` + `ZREMRANGEBYSCORE` + `ZCARD` + `ZADD` + `PEXPIRE` | `O(limit)` per key, 1 RTT | Exact sliding window; uses Redis server `TIME` to avoid app clock skew; higher memory at large `limit`. |
| **Sliding Window Counter** | 2 adjacent window keys (`{key}:cur`, `{key}:prev`); Lua weighted sum `prev * (1 - elapsed/win) + cur` | `O(1)` per key, 1 RTT | Eliminates `2x` boundary burst with `O(1)` memory. **Cluster note:** wrap key in hash tag `{id}` so both bucket keys map to the same slot in one Lua script. |

- **Fail-open vs fail-closed resilience**: `hono-rate-limiter`'s `RedisStore` propagates Redis rejections (`https://github.com/rhinobase/hono-rate-limiter/blob/main/_autodocs/errors.md`). Wrap `store.increment` (or custom middleware) with an explicit policy: **fail-open** (log via `c.get("logger")` and allow request) for general API endpoints vs **fail-closed** (`503`) for sensitive auth/abuse routes.

### 4.3 Standard `RateLimit` and `Retry-After` HTTP Headers

- **HTTP status & `Retry-After`**:
  - **RFC 6585 §4** defines `429 Too Many Requests`, forbids default caching, and permits `Retry-After` (`https://www.rfc-editor.org/rfc/rfc6585.html`).
  - **RFC 9110 §10.2.3** defines `Retry-After` as either non-negative integer `delay-seconds` (e.g., `Retry-After: 42`) or `HTTP-date` (`https://www.rfc-editor.org/rfc/rfc9110.html`).
- **IETF `draft-ietf-httpapi-ratelimit-headers` evolution vs `hono-rate-limiter` behavior**:
  - **Draft-06** (`standardHeaders: "draft-6"` or `true`, default in `hono-rate-limiter`): sets `RateLimit-Policy: <limit>;w=<windowSec>`, `RateLimit-Limit`, `RateLimit-Remaining`, and `RateLimit-Reset` (seconds until reset) (`https://datatracker.ietf.org/doc/html/draft-ietf-httpapi-ratelimit-headers-06`, `https://github.com/rhinobase/hono-rate-limiter/blob/main/_autodocs/api-reference/headers.md`).
  - **Draft-07** (`standardHeaders: "draft-7"` in `hono-rate-limiter`): sets `RateLimit-Policy: <limit>;w=<windowSec>` and combined `RateLimit: limit=<limit>, remaining=<remaining>, reset=<seconds>` (`https://datatracker.ietf.org/doc/html/draft-ietf-httpapi-ratelimit-headers-07`, `https://github.com/rhinobase/hono-rate-limiter/blob/main/_autodocs/api-reference/headers.md`).
  - When rate-limited, `hono-rate-limiter` also sets `Retry-After: <resetSeconds>` (`setRetryAfterHeader`) whenever `standardHeaders` is truthy.
  - **Later IETF drafts (`draft-ietf-httpapi-ratelimit-headers` -08+)**: updated to RFC 8941 Structured Fields with named policy items (`RateLimit-Policy: "default";q=100;w=60` and `RateLimit: "default";r=15;t=23`) (`https://datatracker.ietf.org/doc/draft-ietf-httpapi-ratelimit-headers/`). `hono-rate-limiter` v0.5.4 does not emit the `"default";q=...` structured-field policy format natively; use `"draft-7"` (or `"draft-6"` for legacy clients) unless strict latest-draft syntax is explicitly implemented in custom middleware.

---

## 5. Primary Sources

### Redis Clients (`ioredis` & `node-redis`)
- `ioredis` README (ESM/TS imports, Pub/Sub subscriber mode, `maxRetriesPerRequest`, `rediss://` / TLS): https://github.com/redis/ioredis/blob/main/README.md
- `ioredis` `package.json` & `tsconfig.json` (CJS output, built-in types, Node 20+ in v6): https://github.com/redis/ioredis/blob/main/package.json and https://github.com/redis/ioredis/blob/main/tsconfig.json
- `ioredis` `CHANGELOG.md` (v6 Node 20+ and RESP3 default): https://github.com/redis/ioredis/blob/main/CHANGELOG.md
- `ioredis` `lib/index.ts`, `lib/Redis.ts`, `lib/redis/RedisOptions.ts`, `lib/redis/event_handler.ts`, `lib/utils/RedisCommander.ts`:
  - https://github.com/redis/ioredis/blob/main/lib/index.ts
  - https://github.com/redis/ioredis/blob/main/lib/Redis.ts
  - https://github.com/redis/ioredis/blob/main/lib/redis/RedisOptions.ts
  - https://github.com/redis/ioredis/blob/main/lib/redis/event_handler.ts
  - https://github.com/redis/ioredis/blob/main/lib/utils/RedisCommander.ts
- `ioredis` API docs (`CommonRedisOptions`, `Redis`): https://github.com/redis/ioredis/blob/main/docs/interfaces/CommonRedisOptions.html and https://github.com/redis/ioredis/blob/main/docs/classes/Redis.html
- `node-redis` README (v5 `close()` / `destroy()` replacing `quit()` / `disconnect()`): https://github.com/redis/node-redis/blob/master/README.md
- `node-redis` Pub/Sub, Client Configuration, Command Options, RESP, and Programmability docs:
  - https://github.com/redis/node-redis/blob/master/docs/pub-sub.md
  - https://github.com/redis/node-redis/blob/master/docs/client-configuration.md
  - https://github.com/redis/node-redis/blob/master/docs/command-options.md
  - https://github.com/redis/node-redis/blob/master/docs/RESP.md
  - https://github.com/redis/node-redis/blob/master/docs/programmability.md
- `node-redis` client & socket source (`close`, `destroy`, `resubscribe`): https://github.com/redis/node-redis/blob/master/packages/client/lib/client/index.ts and https://github.com/redis/node-redis/blob/master/packages/client/lib/client/socket.ts
- Official Redis Pub/Sub & Node.js guides: https://redis.io/docs/latest/develop/pubsub/ and https://redis.io/docs/latest/develop/clients/nodejs/

### BullMQ
- BullMQ `package.json` & `changelog.md` (v6 peer dependencies, removal of `repeat`): https://github.com/taskforcesh/bullmq/blob/master/package.json and https://github.com/taskforcesh/bullmq/blob/master/docs/gitbook/changelog.md
- BullMQ Connections & Production guides (`maxRetriesPerRequest: null`, `duplicate()`, `createNodeRedisClient`, `clientFactory`, graceful shutdown):
  - https://docs.bullmq.io/guide/connections
  - https://docs.bullmq.io/guide/going-to-production
  - https://docs.bullmq.io/guide/workers/graceful-shutdown
  - https://docs.bullmq.io/api/classes/v6.RedisConnection.html
- BullMQ Job Schedulers & v5-to-v6 Migration (`upsertJobScheduler`, `removeJobScheduler`, deprecated `repeat`):
  - https://github.com/taskforcesh/bullmq/blob/master/docs/gitbook/guide/jobs/repeatable.md
  - https://github.com/taskforcesh/bullmq/blob/master/docs/gitbook/guide/job-schedulers/README.md
  - https://github.com/taskforcesh/bullmq/blob/master/docs/gitbook/guide/job-schedulers/manage-job-schedulers.md
  - https://github.com/taskforcesh/bullmq/blob/master/docs/gitbook/guide/job-schedulers/repeat-options.md
  - https://docs.bullmq.io/guide/job-schedulers/repeat-strategies
  - https://docs.bullmq.io/guide/migrations/migrate-from-v5-to-v6
- BullMQ Fail-Fast pattern (`enableOfflineQueue: false`): https://github.com/taskforcesh/bullmq/blob/master/docs/gitbook/patterns/failing-fast-when-redis-is-down.md
- BullMQ source (`Worker`, `WorkerOptions`, `RedisConnection`, `ConnectionOptions`):
  - https://github.com/taskforcesh/bullmq/blob/master/src/classes/worker.ts
  - https://github.com/taskforcesh/bullmq/blob/master/src/classes/redis-connection.ts
  - https://github.com/taskforcesh/bullmq/blob/master/src/interfaces/worker-options.ts
  - https://github.com/taskforcesh/bullmq/blob/master/src/interfaces/redis-options.ts

### Hono Rate Limiting & HTTP Standards
- `hono-rate-limiter` API & internal reference (`rateLimiter`, `RedisStore`, `headers`, `configuration`, `types`, `errors`):
  - https://github.com/rhinobase/hono-rate-limiter/blob/main/_autodocs/api-reference/index.md
  - https://github.com/rhinobase/hono-rate-limiter/blob/main/_autodocs/api-reference/rateLimiter.md
  - https://github.com/rhinobase/hono-rate-limiter/blob/main/_autodocs/api-reference/RedisStore.md
  - https://github.com/rhinobase/hono-rate-limiter/blob/main/_autodocs/api-reference/headers.md
  - https://github.com/rhinobase/hono-rate-limiter/blob/main/_autodocs/configuration.md
  - https://github.com/rhinobase/hono-rate-limiter/blob/main/_autodocs/types.md
  - https://github.com/rhinobase/hono-rate-limiter/blob/main/_autodocs/errors.md
- IETF RateLimit Header Fields specs:
  - https://datatracker.ietf.org/doc/draft-ietf-httpapi-ratelimit-headers/
  - https://datatracker.ietf.org/doc/html/draft-ietf-httpapi-ratelimit-headers-06
  - https://datatracker.ietf.org/doc/html/draft-ietf-httpapi-ratelimit-headers-07
- HTTP Status `429` & `Retry-After` RFCs:
  - https://www.rfc-editor.org/rfc/rfc6585.html
  - https://www.rfc-editor.org/rfc/rfc9110.html
