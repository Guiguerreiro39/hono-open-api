# Architecture

This document maps the runtime structure of `hono-open-api-starter` to its source modules and Architecture Decision Records (`ADR-0001` through `ADR-0012`). Consult [docs/adr/](./adr/) for decision rationale and [GLOSSARY.md](../GLOSSARY.md) for canonical terms.

## Three-layer dependency rule

Source code under `src/` obeys `src/modules/ -> src/core/ <- src/infra/` ([ADR-0001](./adr/0001-feature-module-and-ports-architecture.md)).

- **`Core` (`src/core/`).** Driver-agnostic HTTP kernel (`createRouter`, `AppBindings`, `PlatformDeps`), env-agnostic helpers, `AppError` taxonomy (`src/core/errors.ts`), Pino logger (`src/core/logger.ts`), OpenAPI security config (`src/core/openapi.ts`), pagination (`src/core/pagination.ts`), rate-limit policies (`src/core/rate-limit.ts`), auth guards and RBAC statements (`src/core/auth/`), SSE stream builders (`src/core/realtime/sse.ts`), W3C trace context and metrics middleware (`src/core/observability/`), process lifecycle (`src/core/lifecycle.ts`), and `Port` interfaces (`src/core/ports/`). `Core` never imports from `src/infra/` or `src/modules/`.
- **`Infra` (`src/infra/`).** Concrete `Adapter` implementations for auth (`src/infra/auth/`), Drizzle SQLite/libSQL database, migrations, seed, and repositories (`src/infra/db/`), Prometheus and noop metrics (`src/infra/observability/`), Redis cache and rate limiting (`src/infra/redis/`), BullMQ and memory queues (`src/infra/queue/`), Redis and memory pubsub (`src/infra/realtime/`), object storage (`src/infra/storage/`), and `createContainer(env, options?)` (`src/infra/container.ts`).
- **`Feature Module`s (`src/modules/`).** Isolated vertical slices (`system`, `auth`, `tasks`, `files`) owning `<feature>.routes.ts`, `<feature>.handlers.ts`, `<feature>.schema.ts`, optional `<feature>.service.ts`, `<feature>.repository.ts`, `<feature>.jobs.ts`, and `<feature>.test.ts`. Modules depend only on `src/core/`, `@/env` types, and their own files. They accept narrowed `Deps` subsets of `PlatformDeps` and never import `src/infra/` drivers or internals of sibling modules.

## Composition root, startup, and sequential drain

All runtime wiring happens in side-effect-free `Composition Root` factories ([ADR-0001](./adr/0001-feature-module-and-ports-architecture.md), [ADR-0010](./adr/0010-graceful-shutdown-and-lifecycle.md)):

- `createContainer(env, options?)` in `src/infra/container.ts` constructs `PlatformDeps`, repositories, and lifecycle hooks (`isShuttingDown`, `shutdownSignal`, `markShuttingDown`, `abortShutdown`, `forceDisconnect`, `close()`).
- `createApp(deps)` in `src/app.ts` builds the Hono application without import-time side effects, wraps chained `.use()`, `.on()`, and `.get()` calls with `$()`, uses `AUTH_SECURITY` from `src/core/openapi.ts`, mounts `/doc`, `/reference`, `/api/auth/*`, `/_storage/*`, `system`, and `/api/v1` modules, and exports `AppType` for `hc<AppType>` and `testClient(app)`.
- `startApiRuntime` in `src/index.ts` optionally registers embedded worker handlers (`WORKER_EMBEDDED=true`), builds `createApp(container)`, starts `@hono/node-server`, and wires `createProcessLifecycle`.
- `createWorkerRuntime` and `runWorkerProcess` in `src/worker.ts` register module job handlers (`registerModuleJobs`) and recurring cron schedules (`registerModuleSchedules`), optionally start an observability HTTP server on `WORKER_METRICS_PORT` (`/health`, `/metrics`), and wire `createProcessLifecycle`.

Process lifecycle and shutdown (`src/core/lifecycle.ts`) follow a strict sequential drain order ([ADR-0010](./adr/0010-graceful-shutdown-and-lifecycle.md)):

1. On `SIGINT` or `SIGTERM`, `createProcessLifecycle` marks shutdown active and races teardown against an unref'd `SHUTDOWN_TIMEOUT_MS` timer. A second signal forces `process.exit(1)` immediately.
2. **API drain (`src/index.ts`).** `container.markShuttingDown()` flips `GET /ready` to `503 unhealthy` -> sleep `SHUTDOWN_DRAIN_DELAY_MS` if `> 0` -> `container.abortShutdown()` fires `shutdownSignal` to close active SSE streams -> `server.close()` and `server.closeIdleConnections?.()` -> if `WORKER_EMBEDDED=true`, `drainWorkerQueue` drains active jobs bounded by `WORKER_SHUTDOWN_TIMEOUT_MS` -> `container.close()`. On timeout, `server.closeAllConnections?.()` and `container.forceDisconnect()` run before exiting with code `1`.
3. **Worker drain (`src/worker.ts`).** `container.markShuttingDown()` flips worker `/health` to `503` -> `drainWorkerQueue` drains BullMQ worker bounded by `WORKER_SHUTDOWN_TIMEOUT_MS` -> close the `WORKER_METRICS_PORT` HTTP server so final metrics remain scrapable during drain -> `container.close()`.
4. **`Container.close()` teardown order.** `executeCloseSteps` tears down `queue` -> `pubsub` -> `rateLimiter` -> `redis` (when `REDIS_URL` is configured) -> `storage` -> `db`, isolating each step in `try/catch` so one failure never skips subsequent steps.
5. **Fatal errors.** `uncaughtException` and `unhandledRejection` log `fatal` and exit with code `1`.

## Global middleware pipeline and HTTP conventions

`createApp(deps)` registers global middlewares in order before mounting routes ([ADR-0002](./adr/0002-http-api-and-error-conventions.md), [ADR-0007](./adr/0007-observability-metrics-health-and-tracing.md)):

1. `requestId()` (`hono/request-id`): propagates or generates `X-Request-Id`.
2. `traceContext()` (`src/core/observability/trace.ts`): parses inbound W3C `traceparent` or mints new `traceId` and `spanId` inside `AsyncLocalStorage`.
3. `createHttpLogger(deps.logger)` (`hono-pino`): logs compact request/response bindings (`debug` for `<400` probes, `warn` for `4xx`, `error` for `5xx`) with secret redaction.
4. `metricsMiddleware(deps.metrics)`: records `http_requests_total` and `http_request_duration_seconds` post-`next()` using `hono/route` templates (`"__unmatched__"` on `404`), excluding `/metrics`, `/health`, `/ready`, `/favicon.ico`, and omitting durations for `text/event-stream` responses.
5. `cors({ origin: deps.env.CORS_ORIGINS, credentials: true })`.
6. `secureHeaders`: applies default Hono security headers globally, and switches to a dedicated Scalar CSP policy on `/reference` allowing `https://cdn.jsdelivr.net`, `https://fonts.googleapis.com`, `https://fonts.gstatic.com`, and `'unsafe-inline'`.
7. `bodyLimit`: enforces a `1 MB` limit globally, expands to `STORAGE_MAX_FILE_SIZE_BYTES + 64 KB` on `POST /api/v1/files`, and bypasses `/_storage/*`.
8. `timeout`: enforces a `30s` request timeout globally, exempting `/_storage/*`, `GET /api/v1/tasks/live`, `POST /api/v1/files`, and `GET /api/v1/files/{id}/download`.

Route-group rate limiters (`src/core/rate-limit.ts`, [ADR-0005](./adr/0005-redis-caching-and-rate-limiting.md)) sit on `/api/auth/*` and `/api/v1/*`:

| Scope                                                                      | Limit         | Bucket key                            | Exempt or skipped                                                                                          |
| -------------------------------------------------------------------------- | ------------- | ------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Auth mutations (`POST` sign-in, sign-up, password reset/change)            | `10 req/min`  | `ip:<clientIp>` (`TRUST_PROXY`-aware) | Exempt paths (`/health`, `/ready`, `/metrics`, `/doc`, `/reference`, `/api/auth/open-api/generate-schema`) |
| Other `/api/auth/*` requests                                               | `100 req/min` | `ip:<clientIp>`                       | Exempt paths                                                                                               |
| File upload endpoints (`POST /api/v1/files`, `POST /api/v1/files/presign`) | `10 req/min`  | `user:<id>` or `ip:<clientIp>`        | Rate-limited in `files` module                                                                             |
| General `/api/v1/*` routes                                                 | `100 req/min` | `user:<id>` or `ip:<clientIp>`        | Skips `POST /api/v1/files` and `POST /api/v1/files/presign`                                                |

Conventions enforced by `src/core/errors.ts` and `src/core/pagination.ts`:

- **Error envelope.** `notFoundHandler`, `defaultHook` (`422`), and `createErrorHandler` return `{ error: { code, message, requestId, details? } }` for `AppError` subclasses (`BadRequestError`, `UnauthorizedError`, `ForbiddenError`, `NotFoundError`, `RequestTimeoutError`, `ConflictError`, `PayloadTooLargeError`, `ValidationError`, `RateLimitError`, `ServiceUnavailableError`). Wire `500` responses omit internal error messages and stack traces.
- **Resource payloads.** `POST` creations return `201 Created` with an unwrapped entity; empty `PATCH {}` payloads fail Zod refinement with `422`; collections paginate with `base64url` `{ v, id }` cursors returning `{ data, meta: { nextCursor, hasMore } }`.

## Core Port to Adapter matrix

| Contract (`Core` / Module)                                 | `test` (`NODE_ENV=test`)                                                      | `development` (`REDIS_URL` / `S3_BUCKET` unset)            | `production` (or external driver configured)                           |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------- | ---------------------------------------------------------- | ---------------------------------------------------------------------- |
| `AuthPort` (`src/core/ports/auth.ts`)                      | `createAuthAdapter` (`src/infra/auth/`)                                       | `createAuthAdapter`                                        | `createAuthAdapter`                                                    |
| `CachePort` (`src/core/ports/cache.ts`)                    | `MemoryCacheAdapter` (max `1000`, lazy TTL)                                   | `MemoryCacheAdapter`                                       | `RedisCacheAdapter` (`ioredis`, fail-open, O(1) `_ns:` versioning)     |
| `RateLimiterPort` (`src/core/ports/rate-limit.ts`)         | `MemoryRateLimiterAdapter` (`RATE_LIMIT_ENABLED=false` by default)            | `MemoryRateLimiterAdapter`                                 | `RedisRateLimiterAdapter` (`hono-rate-limiter` + `ioredis`, fail-open) |
| `QueuePort` (`src/core/ports/queue.ts`)                    | `MemoryQueueAdapter` (`mode: "buffered"`, explicit `drain()`)                 | `MemoryQueueAdapter` (`mode: "auto"` microtask drain)      | `BullMQQueueAdapter` (shared `"jobs"` queue)                           |
| `PubSubPort` (`src/core/ports/pubsub.ts`)                  | `MemoryPubSubAdapter`                                                         | `MemoryPubSubAdapter`                                      | `RedisPubSubAdapter` (ref-counted `pub`/`sub`, fail-open `publish`)    |
| `StoragePort` (`src/core/ports/storage.ts`)                | `MemoryStorageAdapter` (`/_storage/*`)                                        | `LocalStorageAdapter` (`STORAGE_LOCAL_DIR`, `/_storage/*`) | `S3StorageAdapter` (`@aws-sdk/client-s3`)                              |
| `MetricsPort` (`src/core/ports/metrics.ts`)                | `PromMetricsAdapter` (`collectDefaultMetrics: false`) or `NoopMetricsAdapter` | `PromMetricsAdapter` or `NoopMetricsAdapter`               | `PromMetricsAdapter` or `NoopMetricsAdapter`                           |
| `TaskRepository` (`src/modules/tasks/tasks.repository.ts`) | `createDrizzleTaskRepository` (`:memory:` libSQL)                             | `createDrizzleTaskRepository` (`file:dev.db` WAL)          | `createDrizzleTaskRepository` (`file:` WAL or `libsql://`)             |
| `FileRepository` (`src/modules/files/files.repository.ts`) | `createDrizzleFileRepository` (`:memory:` libSQL)                             | `createDrizzleFileRepository` (`file:dev.db` WAL)          | `createDrizzleFileRepository` (`file:` WAL or `libsql://`)             |

Database clients (`src/infra/db/client.ts`, [ADR-0003](./adr/0003-database-portability-and-migrations.md)) enable `PRAGMA journal_mode = WAL` and `PRAGMA busy_timeout = 5000` on local `file:` URLs so `api` and `worker` share SQLite safely, enable `PRAGMA foreign_keys = ON`, use `casing: "snake_case"` with UUIDv4 `text` primary keys and `timestamp_ms` columns, and normalize SQLite/PostgreSQL constraint failures through `normalizeDbError` (`src/infra/db/errors.ts`).

## Auth and RBAC

Better Auth (`admin`, `bearer`, `openAPI({ disableDefaultReference: true })`, `experimental: { joins: true }`) is wrapped behind `AuthPort` in `src/infra/auth/index.ts` ([ADR-0004](./adr/0004-auth-rbac-and-user-api.md)). Stateless `cookieCache` and Better Auth's internal `rateLimit` are disabled so bans and role updates take effect immediately and `RateLimiterPort` enforces uniform limits.

- `/api/auth/*` forwards `c.req.raw` directly to `deps.auth.handler(...)`.
- `/reference` configures Scalar with `sources: [{ url: "/doc", title: "API" }, { url: "/api/auth/open-api/generate-schema", title: "Auth" }]`.
- `src/modules/auth/` exposes `GET /api/v1/me` and `PATCH /api/v1/me` (`name`, `image` via `AuthPort.updateProfile`).
- `src/core/auth/middlewares.ts` exports `requireAuth` (`401` unauthenticated, `403` when `user.banned` is true), `requireRole`, and `requirePermission`.
- `src/core/auth/permissions.ts` defines `RBAC_STATEMENTS` and `ROLE_STATEMENTS` (`user`, `admin`), including `:any` bypass actions (`task: ["create", "read", "read:any", "update", "update:any", "delete", "delete:any"]`, `file: ["create", "read", "read:any", "delete", "delete:any"]`). Non-privileged callers attempting cross-user `?scope=all` or `?userId=` queries receive `403`, and foreign item IDs return `404` to prevent resource enumeration.

## Realtime SSE

`src/core/realtime/sse.ts` provides `createLiveQueryStream` (which coalesces overlapping `PubSubPort` ticks via `inFlight` and `pending` flags before refetching) and `createEventStream` ([ADR-0008](./adr/0008-realtime-sse-and-pubsub.md)).

- `GET /api/v1/tasks/live` requires `requireAuth` (Better Auth `HttpOnly` cookie or `Authorization: Bearer` header; `?token=` query parameters are not accepted and fail with `401`).
- `TasksService` dual-publishes mutations to `tasks:<userId>` and `tasks:all`.
- Before opening `streamSSE`, `openManagedSseStream` checks `shutdownSignal.aborted`, enforces `MAX_SSE_CONNECTIONS` (`503 SERVICE_UNAVAILABLE` JSON response when full), and awaits `pubsub.subscribe(...)` so the initial `init` snapshot never misses concurrent mutations.
- Streams emit `init` (with `retry: 3000`), `update`, `ping` (every `15_000ms`), and sanitized `error` (`{ error: { code, message, requestId } }`) events, update `MetricsPort` SSE gauges, and abort cleanly when `shutdownSignal` or the client socket closes.

## Object storage and files module

`src/modules/files/` manages private owner-scoped uploads over `StoragePort` ([ADR-0009](./adr/0009-object-storage-and-files-module.md)):

- **Multipart (`POST /api/v1/files`).** Validates `ALLOWED_MIME_TYPES` (`image/jpeg`, `image/png`, `image/webp`, `image/gif`, `application/pdf`, `text/plain`, `text/csv`, `application/json`, excluding SVG/HTML), size (`STORAGE_MAX_FILE_SIZE_BYTES`), and full-buffer magic bytes (`validateMagicBytes` in `src/modules/files/files.validation.ts`), stores under `files/<userId>/<id>`, and persists `"ready"` metadata with SHA-256 checksum.
- **Presigned (`POST /api/v1/files/presign` -> `PUT` -> `POST /api/v1/files/{id}/complete`).** Creates a `"pending"` row with `expiresAt` (`STORAGE_PRESIGN_EXPIRES_SECONDS`), issues a signed `PUT` URL (`STORAGE_PRESIGN_MAX_FILE_SIZE_BYTES`), and on `/complete` checks `storage.head(key)` plus a `4096`-byte range read via `validateMagicBytes` (deleting invalid blobs and returning `422`).
- **Signed transfer parity (`/_storage/*`).** `MemoryStorageAdapter` and `LocalStorageAdapter` share HMAC-SHA256 signed URLs handled by `app.on(["PUT", "GET"], "/_storage/*", ...)`. Under `S3StorageAdapter`, `handleSignedRequest` is undefined so `/_storage/*` returns `404`. `S3StorageAdapter` sets `WHEN_REQUIRED` checksums for S3-compatible providers, omits static credentials when `S3_ACCESS_KEY_ID`/`S3_SECRET_ACCESS_KEY` are unset (allowing IAM/IRSA), and signs presigned URLs against `S3_PUBLIC_ENDPOINT` when provided.
- **Downloads and deletion.** `GET /api/v1/files/{id}/download` streams bytes with `Content-Disposition: attachment`, `X-Content-Type-Options: nosniff`, and `Cache-Control: private, no-store`; `GET /api/v1/files/{id}/url` returns a signed GET URL. Both reject `"pending"` uploads with `409 FILE_PENDING`. `DELETE /api/v1/files/{id}` deletes the DB row first and enqueues `files.deleteObject` if `storage.delete` fails.

## Background jobs and observability

- **Queue and schedules (`src/core/ports/queue.ts`, `src/infra/queue/`, [ADR-0006](./adr/0006-background-jobs-and-worker-topology.md)).** `BullMQQueueAdapter` shares one `"jobs"` queue (`attempts: 3`, `1000ms` exponential backoff, `removeOnComplete: { age: 86400, count: 1000 }`, `removeOnFail: { age: 604800, count: 5000 }`) and validates `defineJob` Zod schemas on both `enqueue` and execution (throwing `UnrecoverableError` on execution schema mismatch). Registered jobs are `tasks.audit` (`src/modules/tasks/tasks.jobs.ts`), `auth.pruneExpired` (`0 3 * * *` UTC cron in `src/modules/auth/auth.jobs.ts`), `files.deleteObject`, and `files.prunePending` (`0 * * * *` UTC cron in `src/modules/files/files.jobs.ts`).
- **Probes and metrics (`src/modules/system/`, `src/infra/observability/`, [ADR-0007](./adr/0007-observability-metrics-health-and-tracing.md)).** `GET /health` returns liveness `{ status: "ok", timestamp }`; `GET /ready` runs `Promise.allSettled` DB and Redis probes bounded by `READINESS_TIMEOUT_MS` (`503 unhealthy` on DB error or shutdown, `200 degraded` on Redis error when `REDIS_URL` is set, `{ status: "skipped" }` when `REDIS_URL` is unset; storage is omitted). `GET /metrics` exposes `PromMetricsAdapter` (per-container `prom-client` `Registry`) with `http_requests_total`, `http_request_duration_seconds`, `sse_active_connections`, `sse_connections_total`, `jobs_processed_total`, `job_duration_seconds`, `cache_operations_total`, `rate_limit_decisions_total`, and Node default metrics (disabled in `test`). Setting `METRICS_ENABLED=false` returns `404`; setting `METRICS_TOKEN` requires `Authorization: Bearer <token>`. Standalone workers optionally expose `/health` and `/metrics` on `WORKER_METRICS_PORT`.
- **Trace correlation (`src/core/observability/trace.ts`, `src/core/logger.ts`).** `traceContext()` populates `AsyncLocalStorage`, `createLogger` injects `trace_id` and `span_id` via Pino `mixin()`, and `QueueEnvelope` propagates `traceparent` from HTTP requests into worker job execution logs.
