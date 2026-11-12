---
status: accepted
---

# Testing strategy, harness isolation, and contract suites

We organize tests into fast zero-dependency `unit` suites co-located in `src/**/*.test.ts` and fail-loud real-infra `integration` suites in `tests/integration/**/*.integration.test.ts` via Vitest `projects` with `fileParallelism: true`, refactor `src/env.ts` to expose side-effect-free `parseEnv(overrides?)` driving `createTestApp(overrides?)` over the real `createApp(deps)` `Composition Root`, default module tests to isolated `:memory:` libSQL DBs (`migrate()`) and real Better Auth seed helpers, verify `Port` and `Drizzle*Repository` parity through shared parameterized contract factories in `tests/contracts/`, and isolate production builds via `tsconfig.build.json`.

## Considered Options

- **Keep `file:test.db` + `execSync("pnpm drizzle-kit push")`, `fileParallelism: false`, and per-router `createTestApp(router)`**: Rejected because shared file-backed SQLite blocks parallel Vitest workers, skips testing committed SQL migrations, and duplicates middleware/auth registration outside `src/app.ts`.
- **Build `InMemory*Repository` fakes per `Feature Module` and mock internals with `vi.mock()`**: Rejected because `:memory:` libSQL is a fast local-substitutable stand-in, parallel repository fakes risk SQL/Drizzle behavior drift, and internal `vi.mock()` couples tests to implementation details instead of module interfaces.
- **Auto-skip missing infra in `test:integration`, enforce coverage % thresholds, and keep `tsc` compiling tests into `./dist`**: Rejected because silent skips mask unverified Redis/BullMQ/S3/lifecycle failures, coverage percentage gates incentivize shallow assertions over thin glue, and emitting test files into `./dist` bloats runtime artifacts.

## Consequences

- `src/env.ts` exports `parseEnv(overrides?)` (applying safe test defaults when `NODE_ENV === "test"` without mutating `process.env`); `tests/helpers/` provides `createTestApp(overrides?)` returning `{ app, client, container, env, seedUser, seedAdmin, seedBannedUser, cleanup }` (calling shared `registerModuleJobs(container)`, `testClient(app)` for typed `AppType` RPC routes, `app.request(...)` for `/api/auth/*`, `/_storage/*`, `/metrics`, and raw inputs, plus `container.close()` / `os.tmpdir()` cleanup) and a zero-dependency `readSseEvents(res, ...)` Web `ReadableStream` reader.
- `vitest.config.ts` enables `fileParallelism: true`, configures `@vitest/coverage-v8` (`text`, `lcov`) without hard percentage gates, and splits `unit` (`src/**/*.test.ts`) from `integration` (`tests/integration/**/*.integration.test.ts`); `package.json` defines `test` (`vitest run --project unit`), `test:watch`, `test:integration` (failing loudly if required Redis/S3/worker infra is unreachable), and `test:coverage`, while `tsconfig.build.json` (`include: ["src/**/*.ts"]`, `exclude: ["src/**/*.test.ts"]`) keeps tests and `vitest` out of `./dist`.
- `tests/contracts/` provides parameterized contract suites for `CachePort`, `RateLimiterPort`, `QueuePort`, `PubSubPort`, and `StoragePort` (covering zero-dep `Memory*` / `LocalStorageAdapter` in `unit` and `Redis*` / `BullMQ*` / `S3*` in `integration`) alongside `:memory:` `Drizzle*Repository` contract suites; JS-clock tests use `vi.useFakeTimers()`, SQLite timestamp pruning tests seed explicit past `expiresAt` rows, `MemoryQueueAdapter` buffers jobs until `await container.queue.drain()`, and `src/core/lifecycle.ts` + `createWorkerRuntime(env)` accept injectable hooks for in-process `unit` drain tests paired with a child-process `SIGTERM`/BullMQ test in `tests/integration/`.
