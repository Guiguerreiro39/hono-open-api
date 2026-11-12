# Development guide

Onboarding workflows, Drizzle and PostgreSQL migrations, new `Feature Module` checklist, testing commands, SSE client recipes, and environment variable reference for `hono-open-api-starter`.

## Tooling setup

The repository targets Node.js `>= 24` and pins `pnpm@10.19.0` in [package.json](../package.json). Enable Corepack once before installing dependencies:

```sh
corepack enable
corepack prepare pnpm@10.19.0 --activate
pnpm install
```

## Three local development modes

### 1. Host only (zero external services)

When `REDIS_URL` and `S3_BUCKET` are unset, `createContainer` selects `MemoryCacheAdapter`, `MemoryRateLimiterAdapter`, `MemoryQueueAdapter` (`mode: "auto"` microtask execution in `development`), `MemoryPubSubAdapter`, and `LocalStorageAdapter` (`./.storage`).

```sh
cp .env.example .env
pnpm db:migrate
pnpm db:seed   # optional: creates admin@example.com and user@example.com
pnpm dev
```

Run `pnpm dev:worker` in a second shell if you want a separate worker process, or set `WORKER_EMBEDDED=true` in `.env` to drain jobs inside the API process.

### 2. Hybrid Compose infra plus host Node

Start Redis and RustFS S3 in Docker while running the API and worker on your host with hot reload:

```sh
docker compose up -d --wait redis s3 s3-init
```

Merge the backing-service variables from [.env.integration.example](../.env.integration.example) into `.env` (`REDIS_URL=redis://localhost:6379`, `STORAGE_DRIVER=s3`, `S3_BUCKET=app-uploads`, `S3_ENDPOINT=http://localhost:9000`, `S3_PUBLIC_ENDPOINT=http://localhost:9000`, `S3_ACCESS_KEY_ID=rustfsadmin`, `S3_SECRET_ACCESS_KEY=rustfsadmin`, `S3_FORCE_PATH_STYLE=true`), then run:

```sh
pnpm db:migrate
pnpm dev
pnpm dev:worker
```

### 3. Full Docker Compose stack

Run `redis`, RustFS `s3`, `s3-init`, one-shot `migrate`, `api` (`:9999`), and `worker` (`:9091`) in containers:

```sh
docker compose up --build -d --wait
```

Include Prometheus (`http://localhost:9090`) and Grafana (`http://localhost:3001`) with the `observability` profile:

```sh
docker compose --profile observability up --build -d --wait
```

RustFS exposes its web console on `http://localhost:9001` (`rustfsadmin` / `rustfsadmin` by default). Stop services with `docker compose down` (add `-v` to wipe volumes).

## Drizzle workflow and PostgreSQL cutover

Schema files live in `src/infra/db/schema/` and SQL migrations live in `src/infra/db/migrations/`.

1. Edit or add tables in `src/infra/db/schema/` using `uuidPk()` and `timestamps()` from `src/infra/db/helpers.ts`.
2. Generate committed SQL migrations: `pnpm db:generate`.
3. Apply migrations to `DATABASE_URL`: `pnpm db:migrate`.
4. Seed default dev accounts (`admin@example.com` / `AdminPassword123!` and `user@example.com` / `UserPassword123!`): `pnpm db:seed`. In `NODE_ENV=production`, `src/infra/db/seed.ts` refuses to run unless `--force` is passed (`pnpm db:seed -- --force`).

### PostgreSQL cutover path

Per [ADR-0003](./adr/0003-database-portability-and-migrations.md), `src/modules/` has zero Drizzle imports so switching from SQLite/libSQL to PostgreSQL stays isolated to `src/infra/`:

1. Replace `@libsql/client` with a PostgreSQL driver (`pg` or `postgres`) and update `src/infra/db/client.ts`, `src/infra/db/migrate.ts`, and `drizzle.config.ts` (`dialect: "postgresql"`).
2. Convert `src/infra/db/helpers.ts` and `src/infra/db/schema/*.ts` from `sqliteTable` to `pgTable` (`uuid` / `text`, `timestamp({ withTimezone: true, mode: "date" })`, and `boolean`), keeping `casing: "snake_case"` and `.returning({ id })`.
3. Update `drizzleAdapter(db, { provider: "pg", schema })` in `src/infra/auth/index.ts`.
4. Reset `src/infra/db/migrations/` and run `pnpm db:generate` to emit a clean PostgreSQL baseline (`normalizeDbError` in `src/infra/db/errors.ts` already maps PostgreSQL codes `23505`, `23503`, `23502`, and `23514`).

## New Feature Module checklist

Use `src/modules/tasks/` and `src/modules/files/` as templates when adding `src/modules/<feature>/`:

1. Define pure `@hono/zod-openapi` DTOs in `<feature>.schema.ts` (use `z.uuid()`, `z.iso.datetime()`, `createPaginatedResponseSchema`, and `z.instanceof(File).openapi({ type: "string", format: "binary" })` for file fields).
2. Define domain interfaces and the repository `Port` in `<feature>.repository.ts` without Drizzle imports.
3. Implement orchestration in `<feature>.service.ts` accepting narrowed `PlatformDeps` fields plus `<Feature>Repository`. Enforce ownership and `:any` bypass permissions via `AuthPort.hasPermission`, returning `NotFoundError` (`404`) on foreign IDs for non-privileged callers.
4. Declare OpenAPI routes in `<feature>.routes.ts` using `createRoute`, `AUTH_SECURITY` from `src/core/openapi.ts`, and `createErrorResponses(...)`.
5. Implement handlers in `<feature>.handlers.ts` using `AppRouteHandler<typeof route>`.
6. Assemble `create<Feature>Module(deps)` in `<feature>.index.ts`, wrapping `.use(...)` chains with `$()` and attaching `requireAuth(deps.auth)` and `requirePermission(...)`.
7. Add any module RBAC resources and actions to `RBAC_STATEMENTS` and `ROLE_STATEMENTS` in `src/core/auth/permissions.ts`.
8. If the module schedules or processes background jobs, define typed jobs with `defineJob` in `<feature>.jobs.ts` and wire them into `registerModuleJobs` and `registerModuleSchedules` in `src/worker.ts`.
9. Add the Drizzle table in `src/infra/db/schema/<feature>.ts`, export it in `src/infra/db/schema/index.ts`, implement `src/infra/db/repositories/drizzle-<feature>.repository.ts`, and run `pnpm db:generate && pnpm db:migrate`.
10. Mount the module under `/api/v1` in `src/app.ts` and expose the repository on `Container` in `src/infra/container.ts`.
11. Add a repository `Contract Suite` in `tests/contracts/` and behavioral tests in `<feature>.test.ts` using `createTestApp` from `tests/helpers/test-app.ts`.

## Testing and verification

| Command                 | Scope                                                              | Notes                                                                                                                     |
| ----------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| `pnpm test`             | Unit project (`src/**/*.test.ts`)                                  | Runs in parallel (`fileParallelism: true`) with isolated `:memory:` libSQL + `migrateDatabase` and zero external services |
| `pnpm test:watch`       | Unit project in watch mode                                         | Re-runs unit specs on edit                                                                                                |
| `pnpm test:coverage`    | Unit project with V8 coverage                                      | Writes `text` and `lcov` reports                                                                                          |
| `pnpm test:integration` | Integration project (`tests/integration/**/*.integration.test.ts`) | Fails loudly if Compose `redis`, `s3`, or `s3-init` is unavailable (`tests/integration/env.ts`)                           |
| `pnpm typecheck`        | TypeScript check (`tsc --noEmit`)                                  | Verifies strict types including `AppType` RPC inference                                                                   |
| `pnpm lint`             | ESLint (`eslint .`)                                                | Enforces formatting, sorted imports, `no-process-env`, and kebab-case filenames                                           |
| `pnpm build`            | Production build (`tsconfig.build.json`)                           | Emits `dist/` excluding `*.test.ts`                                                                                       |

Key testing utilities and patterns ([ADR-0011](./adr/0011-testing-strategy-and-contract-suites.md)):

- **`createTestApp(overrides?)` (`tests/helpers/test-app.ts`).** Builds the real `createApp(container)` over `:memory:` libSQL, calls `registerModuleJobs(container)`, and returns `{ app, client, container, env, seedUser, seedAdmin, seedBannedUser, cleanup }`.
- **Buffered jobs.** In `NODE_ENV=test`, `MemoryQueueAdapter` buffers enqueued jobs until tests call `await container.queue.drain()`.
- **SSE helper (`tests/helpers/sse.ts`).** `readSseEvents(res, { count, timeoutMs, ignoreEvents })` parses `text/event-stream` responses from `app.request(...)` or live HTTP servers without external dependencies.
- **`Contract Suite`s (`tests/contracts/`).** `defineCacheContract`, `defineRateLimiterContract`, `defineQueueContract`, `definePubSubContract`, `defineStorageContract`, `registerTaskRepositoryContractSuite`, and `registerFileRepositoryContractSuite` verify memory/local adapters in `pnpm test` and Redis/BullMQ/S3 adapters in `pnpm test:integration`.
- **Migration drift check.** CI runs `pnpm db:generate` and asserts `git diff --exit-code src/infra/db/migrations` and no untracked migration files.

## SSE client recipes

`GET /api/v1/tasks/live` supports `ListTasksQuerySchema` parameters (`limit`, `cursor`, `scope=all`, `userId=<id>`) and emits four named event types:

- `init`: initial JSON snapshot (`{ data, meta }`) sent with `retry: 3000`.
- `update`: coalesced `{ data, meta }` snapshot emitted after task mutations on `tasks:<userId>` or `tasks:all`.
- `ping`: heartbeat (`{ timestamp }`) emitted every `15_000ms` to keep proxies from closing idle connections.
- `error`: sanitized error envelope (`{ error: { code, message, requestId } }`) if a snapshot refetch fails mid-stream.

Query-string token authentication (`?token=...`) is rejected with `401` to avoid leaking bearer tokens in server logs, proxies, and browser history ([ADR-0008](./adr/0008-realtime-sse-and-pubsub.md)). Use `HttpOnly` session cookies in browsers or `Authorization: Bearer <token>` with `fetch()`.

### Recipe 1: Browser `EventSource` with `HttpOnly` cookies

```ts
export interface TaskDto {
  id: string;
  name: string;
  done: boolean;
  userId: string;
  createdAt: string;
  updatedAt: string;
}

export interface TaskListSnapshot {
  data: TaskDto[];
  meta: { nextCursor: string | null; hasMore: boolean };
}

export function subscribeTasksWithCookies(
  baseUrl: string,
  onSnapshot: (snapshot: TaskListSnapshot) => void,
  onStreamError?: (payload: unknown) => void,
): () => void {
  const url = new URL("/api/v1/tasks/live", baseUrl);
  const source = new EventSource(url.toString(), { withCredentials: true });

  const handleSnapshot = (event: MessageEvent<string>) => {
    onSnapshot(JSON.parse(event.data) as TaskListSnapshot);
  };

  source.addEventListener("init", handleSnapshot);
  source.addEventListener("update", handleSnapshot);
  source.addEventListener("ping", () => {
    // Heartbeat acknowledged; connection is healthy.
  });
  source.addEventListener("error", (event) => {
    if (event instanceof MessageEvent && event.data) {
      onStreamError?.(JSON.parse(event.data));
      return;
    }
    // Browser EventSource retries automatically using the server's `retry: 3000` directive.
    onStreamError?.({ type: "transport_error", readyState: source.readyState });
  });

  return () => {
    source.removeEventListener("init", handleSnapshot);
    source.removeEventListener("update", handleSnapshot);
    source.close();
  };
}
```

### Recipe 2: `fetch()` plus `eventsource-parser` with Bearer token and backoff

Native `EventSource` cannot send custom `Authorization` headers. For token-based API clients, use `fetch()` with `eventsource-parser` (`pnpm add eventsource-parser` in your client app) and exponential reconnect backoff:

```ts
import { createParser } from "eventsource-parser";

export interface TaskListSnapshot {
  data: Array<{
    id: string;
    name: string;
    done: boolean;
    userId: string;
    createdAt: string;
    updatedAt: string;
  }>;
  meta: { nextCursor: string | null; hasMore: boolean };
}

export interface SubscribeBearerOptions {
  baseUrl: string;
  token: string;
  signal: AbortSignal;
  onSnapshot: (snapshot: TaskListSnapshot) => void;
  onServerError?: (error: { code: string; message: string; requestId: string }) => void;
  baseDelayMs?: number;
  maxDelayMs?: number;
}

export async function subscribeTasksWithBearer(options: SubscribeBearerOptions): Promise<void> {
  const {
    baseUrl,
    token,
    signal,
    onSnapshot,
    onServerError,
    baseDelayMs = 1000,
    maxDelayMs = 30_000,
  } = options;

  let attempt = 0;

  while (!signal.aborted) {
    try {
      const response = await fetch(new URL("/api/v1/tasks/live", baseUrl), {
        method: "GET",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "text/event-stream",
        },
        signal,
      });

      if (!response.ok) {
        // Non-retryable client failures (401/403/422); retry 429/503 with backoff.
        if (response.status >= 400 && response.status < 500 && response.status !== 429) {
          throw new Error(`SSE auth or request failure: HTTP ${response.status}`);
        }
        throw new Error(`Transient SSE HTTP status: ${response.status}`);
      }

      if (!response.body) {
        throw new Error("SSE response missing readable body");
      }

      attempt = 0;
      const parser = createParser({
        onEvent(event) {
          if (event.event === "init" || event.event === "update") {
            onSnapshot(JSON.parse(event.data) as TaskListSnapshot);
            return;
          }
          if (event.event === "error") {
            const parsed = JSON.parse(event.data) as {
              error: { code: string; message: string; requestId: string };
            };
            onServerError?.(parsed.error);
          }
        },
      });

      const reader = response.body.getReader();
      const decoder = new TextDecoder();

      while (!signal.aborted) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        parser.feed(decoder.decode(value, { stream: true }));
      }
    }
    catch (err) {
      if (signal.aborted) {
        return;
      }
      if (err instanceof Error && err.message.startsWith("SSE auth or request failure:")) {
        throw err;
      }
    }

    const delayMs = Math.min(maxDelayMs, baseDelayMs * 2 ** attempt);
    attempt += 1;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, delayMs);
      signal.addEventListener("abort", () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
    });
  }
}
```

## Environment variable reference

All 36 environment variables validated by `EnvSchema` in [src/env.ts](../src/env.ts):

### Core and HTTP

| Variable       | Type / values                                                | Default                                                   | Notes                                                    |
| -------------- | ------------------------------------------------------------ | --------------------------------------------------------- | -------------------------------------------------------- |
| `NODE_ENV`     | `development \| test \| production`                          | `development`                                             | Enables strict production checks when `production`       |
| `APP_NAME`     | Non-empty string                                             | `Hono OpenAPI Starter`                                    | Exposed on `GET /`, `/doc`, and Scalar `/reference`      |
| `PORT`         | Integer `0..65535`                                           | `9999`                                                    | API HTTP listening port                                  |
| `LOG_LEVEL`    | `fatal \| error \| warn \| info \| debug \| trace \| silent` | `debug` (`dev`), `silent` (`test`), `info` (`prod`)       | Pino log threshold                                       |
| `CORS_ORIGINS` | Comma-separated `http(s)://` origins or `string[]`           | `["http://localhost:3000"]` (`dev`/`test`), `[]` (`prod`) | Normalized to origin; feeds Better Auth `trustedOrigins` |
| `TRUST_PROXY`  | Boolean (`true/1`, `false/0`)                                | `false`                                                   | Reads `X-Forwarded-For` and `X-Real-IP` when `true`      |

### Database

| Variable              | Type / values                                           | Default                                                       | Notes                                                        |
| --------------------- | ------------------------------------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------ |
| `DATABASE_URL`        | `:memory:` or `file:`, `libsql:`, `http:`, `https:` URL | `:memory:` (`test`), `file:dev.db` (`dev`), required (`prod`) | Local `file:` enables WAL and `busy_timeout = 5000`          |
| `DATABASE_AUTH_TOKEN` | Non-empty string                                        | Unset                                                         | Required in `production` for `libsql://` and `https://` URLs |

### Authentication

| Variable             | Type / values                      | Default                                                   | Notes                                                     |
| -------------------- | ---------------------------------- | --------------------------------------------------------- | --------------------------------------------------------- |
| `BETTER_AUTH_SECRET` | Non-empty string                   | `"secret"` (`dev`/`test`), required (`prod`)              | In `production`, must be `>= 32` chars and not `"secret"` |
| `BETTER_AUTH_URL`    | `http://` or `https://` origin URL | `http://localhost:9999` (`dev`/`test`), required (`prod`) | Base URL for Better Auth and local signed storage URLs    |

### Redis, rate limiting, and SSE

| Variable              | Type / values                 | Default                                 | Notes                                                 |
| --------------------- | ----------------------------- | --------------------------------------- | ----------------------------------------------------- |
| `REDIS_URL`           | `redis://` or `rediss://` URL | Unset (`dev`/`test`), required (`prod`) | Enables Redis cache, rate limit, BullMQ, and PubSub   |
| `CACHE_PREFIX`        | Non-empty string              | `app`                                   | Key prefix for cache, rate limits, BullMQ, and PubSub |
| `RATE_LIMIT_ENABLED`  | Boolean                       | `false` (`test`), `true` (`dev`/`prod`) | Toggles `RateLimiterPort` middlewares                 |
| `MAX_SSE_CONNECTIONS` | Integer `>= 0`                | `1000`                                  | Per-process SSE cap (`0` disables limit)              |

### Worker and process lifecycle

| Variable                     | Type / values    | Default | Notes                                                   |
| ---------------------------- | ---------------- | ------- | ------------------------------------------------------- |
| `WORKER_EMBEDDED`            | Boolean          | `false` | Runs worker inside API process when `true`              |
| `WORKER_CONCURRENCY`         | Positive integer | `5`     | BullMQ worker concurrency                               |
| `WORKER_SHUTDOWN_TIMEOUT_MS` | Positive integer | `10000` | Max wait for `drainWorkerQueue`                         |
| `SHUTDOWN_TIMEOUT_MS`        | Positive integer | `10000` | Hard deadline for `SIGINT`/`SIGTERM` shutdown           |
| `SHUTDOWN_DRAIN_DELAY_MS`    | Integer `>= 0`   | `0`     | Delay after `/ready` turns `503` before closing sockets |

### Observability

| Variable               | Type / values      | Default | Notes                                                             |
| ---------------------- | ------------------ | ------- | ----------------------------------------------------------------- |
| `READINESS_TIMEOUT_MS` | Positive integer   | `2000`  | Timeout per DB/Redis probe on `/ready` and worker `/health`       |
| `METRICS_ENABLED`      | Boolean            | `true`  | `false` uses `NoopMetricsAdapter` and returns `404` on `/metrics` |
| `METRICS_TOKEN`        | Non-empty string   | Unset   | When set, `/metrics` requires `Authorization: Bearer <token>`     |
| `WORKER_METRICS_PORT`  | Integer `0..65535` | Unset   | Starts worker `/health` and `/metrics` HTTP server when set       |

### Object storage and S3

| Variable                              | Type / values               | Default                                                              | Notes                                                                          |
| ------------------------------------- | --------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `STORAGE_DRIVER`                      | `memory \| local \| s3`     | `memory` (`test`), `s3` (`prod` or if `S3_BUCKET` set), else `local` | Selects `StoragePort` adapter                                                  |
| `STORAGE_LOCAL_DIR`                   | Non-empty path              | `./.storage`                                                         | Root directory for `LocalStorageAdapter`                                       |
| `STORAGE_MAX_FILE_SIZE_BYTES`         | Positive integer            | `10485760` (`10 MB`)                                                 | Max size for `POST /api/v1/files` multipart uploads                            |
| `STORAGE_PRESIGN_MAX_FILE_SIZE_BYTES` | Positive integer            | `104857600` (`100 MB`)                                               | Max size for presigned uploads                                                 |
| `STORAGE_PRESIGN_EXPIRES_SECONDS`     | Positive integer            | `900` (`15 min`)                                                     | Expiration for presigned PUT and GET URLs                                      |
| `STORAGE_SIGNING_SECRET`              | Non-empty string            | Falls back to `BETTER_AUTH_SECRET`                                   | HMAC-SHA256 secret for `/_storage/*` signed URLs                               |
| `S3_BUCKET`                           | Non-empty string            | Unset                                                                | Required when `STORAGE_DRIVER` is `s3`                                         |
| `S3_REGION`                           | Non-empty string            | `us-east-1`                                                          | AWS S3 / RustFS region                                                         |
| `S3_ENDPOINT`                         | `http://` or `https://` URL | Unset                                                                | Internal S3-compatible endpoint (e.g. `http://s3:9000`)                        |
| `S3_PUBLIC_ENDPOINT`                  | `http://` or `https://` URL | Unset                                                                | Browser-reachable origin for presigned S3 URLs                                 |
| `S3_ACCESS_KEY_ID`                    | Non-empty string            | Unset                                                                | Optional static key (must pair with `S3_SECRET_ACCESS_KEY`; omit for IAM/IRSA) |
| `S3_SECRET_ACCESS_KEY`                | Non-empty string            | Unset                                                                | Optional static secret (must pair with `S3_ACCESS_KEY_ID`)                     |
| `S3_FORCE_PATH_STYLE`                 | Boolean                     | `false`                                                              | Enables path-style S3 addressing for RustFS/MinIO                              |
