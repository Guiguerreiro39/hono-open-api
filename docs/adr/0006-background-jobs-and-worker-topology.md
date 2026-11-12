---
status: accepted
---

# Background job queues, cron scheduling, and worker topology

We encapsulate background jobs and recurring schedules behind a narrow `QueuePort` (`src/core/ports/queue.ts`) and typed `defineJob({ name, schema })` helper inside `Core`, route all jobs through a single shared BullMQ queue (`"jobs"`) inside `src/infra/queue/` with zero-dep `MemoryQueueAdapter` fallback when `REDIS_URL` is unset, run a dedicated `src/worker.ts` process in production (with optional `WORKER_EMBEDDED=true` for single-process local dev), register cron schedules declaratively at worker startup via idempotent `upsertJobScheduler`, and use BullMQ's bounded `failed` set as an inspectable dead-letter store.

## Considered Options

- **Multiple named queues (`default`, `critical`, `maintenance`) with per-queue workers**: Rejected because each BullMQ `Worker` duplicates a dedicated blocking Redis connection (`maxRetriesPerRequest: null`), multiplying connection counts against managed Redis limits and widening `QueuePort` when per-job `attempts`, `backoff`, and `delayMs` options on a single `"jobs"` queue suffice.
- **Centralized `src/modules/jobs/` owning all schemas and handlers, or TS-only unvalidated payloads**: Rejected because centralizing handlers inside one module couples `Feature Module` internals together (violating ADR-0001), while skipping Zod validation risks silent runtime errors on malformed producer payloads or stale serialized Redis jobs after deploys.
- **Separate shadow DLQ queue, legacy `repeat` APIs, and auto-starting workers inside `createApp(deps)`**: Rejected because legacy `repeat` APIs were removed in BullMQ v6, maintaining a separate shadow DLQ queue duplicates failure tracking when bounded `removeOnFail` retention preserves failed jobs for inspection/retry, and embedding workers unconditionally in `createApp` breaks side-effect-free app composition and independent API/worker scaling.

## Consequences

- `src/core/ports/queue.ts` owns `QueuePort` (`enqueue`, `registerHandler`, `upsertSchedule`, `removeSchedule`, `ping`, `close`) and `defineJob({ name, schema })`; `Feature Module`s declare `<feature>.jobs.ts` (Zod payload schema + handler factory taking narrowed module `Deps`), and the `Composition Root` (`createContainer` / `src/worker.ts`) validates payloads with Zod on both `enqueue` and execution (throwing BullMQ `UnrecoverableError` on execution schema mismatch so invalid payloads fail immediately without retries).
- `src/infra/queue/` provides `BullMQQueueAdapter` (fail-fast `Queue` producer per ADR-0005 + `maxRetriesPerRequest: null` `Worker`, prefix `${CACHE_PREFIX}:bull`, defaults `attempts: 3`, exponential `1000ms` backoff, `removeOnComplete: { age: 86400, count: 1000 }`, `removeOnFail: { age: 604800, count: 5000 }`) and `MemoryQueueAdapter` (buffered + explicit `drain()`/`getJobs()`/`getSchedules()`/`clear()` in `NODE_ENV=test`, async `queueMicrotask` auto-drain in `development` when `REDIS_URL` is unset, zero background `setInterval` timers).
- `src/env.ts` adds `WORKER_EMBEDDED` (`false` default), `WORKER_CONCURRENCY` (`5` default), and `WORKER_SHUTDOWN_TIMEOUT_MS` (`10000` default); `src/worker.ts` (`pnpm dev:worker` / `pnpm start:worker`) assembles `createContainer(env)`, registers module handlers and idempotent `upsertSchedule` crons, and drains via `worker.close()` + `queue.close()` (with timeout fallback `worker.close(true)`).
- Jobs require idempotent handlers (at-least-once delivery) and caller-supplied deterministic `jobId` (without `:`) when deduplicating; job metadata propagates `trace_id`/`span_id` into a Pino child logger (`{ jobId, jobName, attempt, trace_id }`) and optional `onJobComplete`/`onJobFailed` lifecycle hooks, illustrated by an on-demand `tasks.audit` job and a daily `auth.pruneExpired` cron pruning expired `session`/`verification` rows.
