# Agent guide

## Agent skills

### Issue tracker

Issues and specs live as GitHub Issues in `Guiguerreiro39/hono-open-api` (via `gh`). See `docs/agents/issue-tracker.md`.

### Triage labels

Canonical 1:1 triage labels (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context layout (`GLOSSARY.md` + `docs/adr/` at repo root). See `docs/agents/domain.md`.

## Engineering guardrails

- **Layer boundaries (`src/modules/` -> `src/core/` <- `src/infra/`).** `Core` and `Feature Module`s depend only on `Port` interfaces and narrowed `PlatformDeps` subsets, never concrete `Infra` drivers or another module's internals.

- **Side-effect-free composition.** Keep `createApp(deps)` in `src/app.ts` and `parseEnv(overrides?)` in `src/env.ts` free of import-time side effects, and keep `process.env` reads isolated to `src/env.ts` (`node/no-process-env`).

- **Typed RPC inference.** Wrap chained `.use()`, `.on()`, and `.get()` calls with `$()` and share `AUTH_SECURITY` from `src/core/openapi.ts` so `AppType` stays intact.

- **Uniform errors and payloads.** Throw `AppError` subclasses from `src/core/errors.ts` (`{ error: { code, message, requestId, details? } }`), return `201` on resource creation, reject empty `PATCH {}` with `422`, and paginate lists with `base64url` `{ v, id }` cursors.

- **Auth and ownership.** Use `requireAuth` and `requirePermission` with Better Auth `/api/auth/*`, enforce `:any` bypass permissions for cross-user queries, and return `404` on foreign resource IDs for non-privileged callers.

- **Ports and fallbacks.** Consume `CachePort`, `RateLimiterPort`, `QueuePort`, `PubSubPort`, `StoragePort`, and `MetricsPort` through `PlatformDeps` so zero-dependency `Adapter`s work identically in `development` and `test`.

- **Database and migrations.** Keep Drizzle tables and queries inside `src/infra/db/` (`casing: "snake_case"`, `.returning({ id })`, committed SQL migrations via `pnpm db:generate` and `pnpm db:migrate`).

- **File naming and style.** Name source and doc files in `kebab-case` (except `README.md` and root uppercase docs) and keep imports sorted per `eslint.config.mjs`.

- **Behavior-only testing.** Test through `createTestApp(overrides?)` (`:memory:` libSQL + `migrateDatabase`), `testClient(app)`, `app.request`, `container.queue.drain()`, `readSseEvents`, and `tests/contracts/` `Contract Suite`s. Avoid internal `vi.mock()` patching and clean up any temporary `dev.db`, `test.db`, or `.storage/` files.

- **Verification gates.** Before reporting done, pass `pnpm typecheck`, `pnpm lint`, `pnpm test`, and `pnpm build` (plus `pnpm db:generate && git diff --exit-code src/infra/db/migrations` after schema edits, and `pnpm test:integration` when Compose infra is running).

## Context pointers

- `GLOSSARY.md`: consult when naming modules, ports, adapters, repositories, or test suites.
- `docs/architecture.md`: consult when editing middlewares, `Container` lifecycle drains, `Port` to `Adapter` bindings, SSE, storage, or observability.
- `docs/development.md`: consult when adding environment variables, running Drizzle or Compose workflows, writing SSE clients, or scaffolding a `Feature Module`.
- `docs/adr/`: consult before changing architectural boundaries, HTTP conventions, DB portability, auth, Redis, queues, observability, SSE, storage, shutdown, testing, or CI/Docker (`ADR-0001` through `ADR-0012`).
