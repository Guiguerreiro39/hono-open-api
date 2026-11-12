---
status: accepted
---

# Graceful shutdown drain order and process lifecycle

We coordinate process startup, signal handling (`SIGINT`/`SIGTERM`), readiness short-circuiting, and bounded teardown across `src/index.ts` and `src/worker.ts` through a shared `Core` lifecycle helper (`src/core/lifecycle.ts`), carry `isShuttingDown` and `shutdownSignal` on `PlatformDeps` so `/ready` returns `503 unhealthy` and active SSE streams abort before HTTP draining, and drain sequentially (HTTP/SSE → embedded worker if `WORKER_EMBEDDED=true` → `container.close()`) with timeout escalation and fail-fast fatal error handling.

## Considered Options

- **Close `container.close()` before/concurrently with HTTP `server.close()`, or call `server.close()` before aborting SSE streams**: Rejected because Node's `server.close()` waits indefinitely on open `text/event-stream` sockets unless `shutdownSignal` aborts SSE streams first, while closing DB, Redis, or PubSub before active HTTP handlers and jobs finish causes in-flight requests to fail mid-flight.
- **Drain HTTP and embedded worker concurrently, or return `200` on `/ready` until `server.close()` finishes**: Rejected because sequential draining guarantees finishing HTTP requests can still enqueue jobs cleanly before the worker stops, while short-circuiting `/ready` to `503` immediately signals orchestrators to stop routing new traffic without wasting DB/Redis pings during teardown.
- **Duplicate signal/timeout handlers in each entrypoint or run full graceful drains on `uncaughtException` / `unhandledRejection`**: Rejected because sharing `src/core/lifecycle.ts` prevents drift between `src/index.ts` and `src/worker.ts`, whereas continuing or running slow drains after uncaught exceptions risks acting on corrupted process state instead of logging `fatal` and letting the supervisor restart cleanly.

## Consequences

- `src/env.ts` adds `SHUTDOWN_TIMEOUT_MS` (`10000` default, matching `WORKER_SHUTDOWN_TIMEOUT_MS` in ADR-0006) and `SHUTDOWN_DRAIN_DELAY_MS` (`0` default, configurable for orchestrator load-balancer propagation before closing sockets).
- `PlatformDeps` adds optional `isShuttingDown?: () => boolean` and `shutdownSignal?: AbortSignal` (defaulting to `() => false` and an un-aborted signal in `createTestApp`); `system` `GET /ready` short-circuits to `503` `{ status: "unhealthy", timestamp, checks: { db: { status: "skipped" }, redis: { status: "skipped" } } }` once shutting down, while `createLiveQueryStream`/`createEventStream` abort cleanly on `shutdownSignal`.
- `createContainer(env)` returns `Container` (`PlatformDeps & { close(): Promise<void> }`), closing `Infra` `Adapter`s in reverse-dependency order (`queue.close()` → `pubsub.close()` → `cache`/`rateLimiter` Redis `quit()` → `db.close()`), isolating each step via `try/catch` or `Promise.allSettled` so one adapter failure never skips tearing down the rest.
- `src/core/lifecycle.ts` owns idempotent single-flight signal registration, unref'd timeout racing (`SHUTDOWN_TIMEOUT_MS`), second-signal immediate force-exit (`1`), startup error handling (server `error` / boot failure → `logger.fatal`, `await container.close()`, `process.exit(1)`), and `uncaughtException` / `unhandledRejection` handling (`logger.fatal` + `process.exit(1)`).
- `src/index.ts` keeps startup non-blocking and drains sequentially (`isShuttingDown = true` + `SHUTDOWN_DRAIN_DELAY_MS` → `shutdownController.abort()` → `server.close()` + `server.closeIdleConnections()` → embedded worker drain when `WORKER_EMBEDDED=true` → `container.close()`, escalating to `server.closeAllConnections()`, `worker.close(true)`, Redis `disconnect()`, and exit `1` on timeout); `src/worker.ts` flips optional `WORKER_METRICS_PORT` `/health` to `503`, drains BullMQ `worker.close()` bounded by `WORKER_SHUTDOWN_TIMEOUT_MS` (`worker.close(true)` fallback), closes the metrics server after worker drain so final job metrics remain scrapable, and finishes with `container.close()`.
