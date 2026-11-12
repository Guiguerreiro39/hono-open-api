---
status: accepted
---

# HTTP API, error envelope, and observability conventions

We standardize all starter endpoints around a canonical JSON error envelope (`{ error: { code, message, requestId, details? } }`) backed by Core `AppError` subclasses, prefix versioned Feature Module endpoints under `/api/v1` via the `Composition Root`, return unwrapped single resources alongside `{ data, meta }` cursor-paginated collections, and replace `console.*` / ad-hoc `stoker` error middlewares with a shared Pino logger (`createLogger`), `X-Request-Id` propagation, and edge guardrails.

## Considered Options

- **RFC 9457 Problem Details (`application/problem+json`) or existing `stoker` ad-hoc shapes (`{ message }` + `{ success, error }`)**: Rejected because `stoker`'s `onError` leaks raw error messages on 500s and mixes incompatible shapes across validation, auth, and 404 responses, while `application/problem+json` adds friction to Hono `hc<AppType>` JSON client typing compared to a uniform `application/json` `{ error }` envelope.
- **Unversioned root paths (`/tasks`) or `/api/*` without version**: Rejected because Feature Module endpoints already coexist with Better Auth (`/api/auth/*`) and system probes; mounting modules under `/api/v1` isolates breaking API changes without polluting module-local route definitions.
- **Offset pagination (`page`/`limit`) and `{ data: T }` single-item wrapping**: Rejected because cursor pagination (`base64url` `{ v, id }` + `limit`) stays O(1) across SQLite/PostgreSQL without extra `COUNT(*)` queries or live-SSE drift, while unwrapped single items keep `hc<AppType>` ergonomic.

## Consequences

- `src/core/` owns `AppError` subclasses (`BadRequestError`, `UnauthorizedError`, `ForbiddenError`, `NotFoundError`, `ConflictError`, `ValidationError`, `PayloadTooLargeError`, `RateLimitError`, `RequestTimeoutError`, `ServiceUnavailableError`), global `notFound`/`onError`/OpenAPI `defaultHook`, `createErrorResponses(...)`, and `createLogger(env)` (`isoTime`, `trace_id`/`span_id` mixin, secret `redact`, compact `hono-pino` HTTP bindings, `debug`-level `<400` probe logs).
- `createApp(deps)` mounts version-agnostic Feature Module routers under `/api/v1`, leaves `/`, `/health`, `/ready`, `/metrics`, `/doc`, `/reference`, and `/api/auth/*` (native Better Auth responses) unversioned, validates inbound `X-Request-Id`, and enforces `CORS_ORIGINS`, `secureHeaders` (Scalar `/reference` CSP exception), upload-exempt `1 MB` `bodyLimit`, and SSE-exempt `30s` `timeout`.
- Resource `POST` creation returns `201 Created` (empty `PATCH` `{}` remains `422`), `src/env.ts` validates `NODE_ENV` (`development | test | production`) with `LOG_LEVEL` defaults and fails fast via `process.stderr.write`, and `500` responses always omit internal messages/stacks from the wire payload (logged via Pino with `requestId`).
