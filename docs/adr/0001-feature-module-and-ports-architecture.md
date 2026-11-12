---
status: accepted
---

# Feature-module and ports-and-adapters architecture

We reorganize `src/` from flat `routes/`, `lib/`, `middlewares/`, and `db/` directories into three layers—`src/core/` (HTTP kernel, `AppBindings`, OpenAPI, env, shared middlewares, port contracts), `src/infra/` (concrete adapters and `createContainer(env)`), and `src/modules/` (prefixed `<feature>.*` vertical slices)—assembled by a side-effect-free `createApp(deps)` composition root in `src/app.ts` that exposes `AppType = ReturnType<typeof createApp>` and backs `createTestApp(overrides?)`.

## Considered Options

- **Keep flat `routes/` + module-level singletons (`db`, `pubsub`) + separate `createTestApp` middleware wiring**: Rejected because it duplicates auth/middleware registration between `src/app.ts` and tests, leaks driver-specific errors (`SQLITE_CONSTRAINT`, `rowsAffected`) into handlers, and cannot inject in-memory/test stand-ins or reuse logic in background workers without a Hono `Context`.
- **Two-bucket layout (`src/core/adapters/` + `src/modules/`) with Hono context middleware DI (`c.var.deps`)**: Rejected because placing concrete drivers inside `src/core/` blurs pure contracts with infra dependencies, and injecting dependencies via HTTP middleware ties module services/repositories to Hono `Context` rather than plain function parameters.
- **Dynamic module registration loop in `createApp`**: Rejected because iterating over modules erases chained Hono route types, breaking end-to-end `hc<AppType>` RPC inference.

## Consequences

- `src/app.ts` remains free of import-time side effects; runtime entrypoints (`src/index.ts`, future `src/worker.ts`) construct `createContainer(env)` and pass it into `createApp(container)`.
- Modules declare narrowed `Deps` interfaces, attach their own route-level auth/rate-limit guards next to their OpenAPI `security` specs, and never import concrete `src/infra/` drivers or internals of other modules.
- Rebrands the starter via `APP_NAME` (default `"Hono OpenAPI Starter"`), keeps `system`, `auth`, `tasks`, and `files` reference modules, and retires custom `src/routes/users/` in favor of Better Auth `admin` + `/me`.
