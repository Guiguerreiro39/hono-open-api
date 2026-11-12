# Hono OpenAPI Starter

Production-ready Node.js backend starter built on Hono, Zod OpenAPI, Better Auth, and Drizzle ORM with swappable infrastructure adapters.

## Prerequisites

- Node.js `>= 24` (`engines.node` in [package.json](./package.json))
- `pnpm@10.19.0` via Corepack (`corepack enable && corepack prepare pnpm@10.19.0 --activate`)
- Docker and Docker Compose (optional, for Redis, RustFS S3, and Prometheus/Grafana)

## Included stack

- HTTP and OpenAPI 3.0.0: [hono](https://hono.dev/) and [@hono/zod-openapi](https://github.com/honojs/middleware/tree/main/packages/zod-openapi) with typed RPC `AppType`
- API reference UI: [@scalar/hono-api-reference](https://github.com/scalar/scalar/tree/main/packages/hono-api-reference) combining `/doc` and Better Auth schemas
- Authentication and RBAC: [better-auth](https://www.better-auth.com/) (`admin`, `bearer`, `openAPI`) behind `AuthPort`
- Database and migrations: [drizzle-orm](https://orm.drizzle.team/) with `@libsql/client` (SQLite/libSQL) and SQL migrations
- Caching, rate limiting, and queues: `ioredis`, `hono-rate-limiter`, and `bullmq` with zero-dependency in-memory fallbacks
- Realtime and storage: Server-Sent Events over `PubSubPort` and `@aws-sdk/client-s3` with local disk and memory fallbacks
- Observability: `pino`, `hono-pino`, W3C `traceparent` context, and `prom-client` `/metrics`
- Quality tooling: [vitest](https://vitest.dev/), `typescript`, and [@antfu/eslint-config](https://github.com/antfu/eslint-config)

## Quick start

### Host only (zero external services)

```sh
cp .env.example .env
pnpm install
pnpm db:migrate
pnpm db:seed   # optional: seeds admin@example.com and user@example.com
pnpm dev
```

The API listens on `http://localhost:9999` and serves Scalar docs at `http://localhost:9999/reference`. Run `pnpm dev:worker` in a second terminal for a standalone worker, or set `WORKER_EMBEDDED=true` in `.env` for single-process execution.

### Docker Compose (full stack)

```sh
docker compose up --build -d --wait
```

This starts `redis`, RustFS `s3` (console on `http://localhost:9001`), `s3-init`, one-shot `migrate`, `api` on `http://localhost:9999`, and `worker` with metrics on port `9091`. Add `--profile observability` to include Prometheus (`http://localhost:9090`) and Grafana (`http://localhost:3001`), or start only backing infrastructure with `docker compose up -d --wait redis s3 s3-init`.

## Scripts

| Script                  | Purpose                                                     |
| ----------------------- | ----------------------------------------------------------- |
| `pnpm dev`              | Run API server in watch mode (`src/index.ts`)               |
| `pnpm dev:worker`       | Run background worker in watch mode (`src/worker.ts`)       |
| `pnpm start`            | Run compiled API server (`dist/src/index.js`)               |
| `pnpm start:worker`     | Run compiled worker (`dist/src/worker.js`)                  |
| `pnpm typecheck`        | Run TypeScript compiler check (`tsc --noEmit`)              |
| `pnpm lint`             | Run ESLint across the repository                            |
| `pnpm lint:fix`         | Run ESLint with auto-fix                                    |
| `pnpm test`             | Run parallel unit tests (`src/**/*.test.ts`)                |
| `pnpm test:watch`       | Run unit tests in watch mode                                |
| `pnpm test:integration` | Run real-infra integration tests (`tests/integration/`)     |
| `pnpm test:coverage`    | Run unit tests with V8 coverage report                      |
| `pnpm build`            | Build production bundle via `tsconfig.build.json`           |
| `pnpm db:generate`      | Generate Drizzle SQL migrations from `src/infra/db/schema/` |
| `pnpm db:migrate`       | Apply SQL migrations to `DATABASE_URL`                      |
| `pnpm db:seed`          | Seed default dev users (requires `--force` in `production`) |

## Endpoint groups

| Group             | Endpoints                                                                                                                                                                                                                         | Notes                                                                                   |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| System and docs   | `GET /`, `GET /health`, `GET /ready`, `GET /metrics`, `GET /doc`, `GET /reference`                                                                                                                                                | `/metrics` is excluded from `/doc` and supports `METRICS_TOKEN`                         |
| Better Auth       | `/api/auth/*`                                                                                                                                                                                                                     | Sign-up, sign-in, admin (`/api/auth/admin/*`), and `/api/auth/open-api/generate-schema` |
| Profile           | `GET /api/v1/me`, `PATCH /api/v1/me`                                                                                                                                                                                              | Authenticated self-service profile read and update                                      |
| Tasks and SSE     | `GET /api/v1/tasks`, `GET /api/v1/tasks/live`, `POST /api/v1/tasks`, `GET /api/v1/tasks/{id}`, `PATCH /api/v1/tasks/{id}`, `DELETE /api/v1/tasks/{id}`                                                                            | Owner-scoped CRUD with `:any` admin bypass and live SSE stream                          |
| Files and storage | `GET /api/v1/files`, `POST /api/v1/files`, `POST /api/v1/files/presign`, `POST /api/v1/files/{id}/complete`, `GET /api/v1/files/{id}/download`, `GET /api/v1/files/{id}/url`, `DELETE /api/v1/files/{id}`, `PUT\|GET /_storage/*` | Multipart and presigned uploads with HMAC `/_storage/*` parity in dev and test          |

## Documentation

- [Architecture](./docs/architecture.md): system map, layer rules, middleware pipeline, lifecycle drain, and `Port` to `Adapter` matrix
- [Development](./docs/development.md): local dev modes, Drizzle and PostgreSQL migration workflow, new module checklist, SSE client recipes, and env var reference
- [Glossary](./GLOSSARY.md): canonical project vocabulary
- [Architecture Decision Records](./docs/adr/): `ADR-0001` through `ADR-0012`
