---
status: accepted
---

# Authentication hardening, RBAC model, and `/me` vs admin user API

We isolate Better Auth (`admin`, `bearer`, `openAPI`) behind a `Core` `AuthPort` in `src/core/ports/auth.ts` and pure-TypeScript RBAC statements in `src/core/auth/permissions.ts`, mount `/api/auth/*` directly onto `auth.handler(c.req.raw)` without `clonedReq` or manual auth route definitions, link Better Auth's schema into Scalar `/reference` via multi-source `sources`, use Better Auth `/api/auth/admin/*` directly for admin user management while retiring `src/routes/users/` in favor of `/api/v1/me` (`GET` / `PATCH`) inside `src/modules/auth/`, and enforce `userId` ownership with explicit `:any` admin-bypass permissions.

## Considered Options

- **Import `better-auth` types directly in `src/core/` and proxy `/api/v1/admin/users`**: Rejected because leaking `better-auth` into `Core` violates ADR-0001's `modules → core ← infra` rule, while custom `/api/v1/admin/users` endpoints duplicate Better Auth `admin()`'s native user, role, ban, session, and impersonation routes.
- **Merge Better Auth's OpenAPI `3.1.1` spec into Hono's `/doc` (`3.0.0`) or wrap auth routes with `.openapi(...)`**: Rejected because `@hono/zod-openapi` consumes the single-use `Request.body` stream (requiring the `clonedReq` hack and manual `auth.routes.ts` schemas), while merging specs requires OpenAPI `3.1` path-prefix and component reconciliation when Scalar's native `sources` array consumes `/doc` and `/api/auth/open-api/generate-schema` cleanly side by side.
- **Strict owner-only isolation (no admin bypass) or implicit `role === "admin"` checks returning `403`**: Rejected because starter admins need cross-user moderation/support via explicit `:any` capabilities (`read:any`, `update:any`, `delete:any`) checked through `AuthPort.hasPermission`, while non-privileged callers receive `404 NotFoundError` on foreign IDs to avoid cross-user resource enumeration.
- **Enable Better Auth `cookieCache` or default-allow weak secrets outside tests**: Rejected because stateless `cookieCache` delays ban and role-revocation enforcement, and permitting `"secret"` in `production` risks forged session signatures.

## Consequences

- `src/env.ts` rejects default/short `BETTER_AUTH_SECRET` (`< 32` chars or `"secret"`) and requires explicit URL `BETTER_AUTH_URL` when `NODE_ENV=production` (keeping dev/test defaults), deriving `trustedOrigins` from `CORS_ORIGINS` + `BETTER_AUTH_URL` origin.
- `src/infra/auth/` implements `AuthPort` (`getSession`, `hasPermission`, `updateProfile`, `handler`) with `admin({ ac, roles })` (keeping default 1h impersonation and exposing `impersonatedBy` on `AuthSession`), `bearer()`, `openAPI({ disableDefaultReference: true })`, `experimental: { joins: true }`, `httpOnly` + `sameSite: "lax"` (`secure` in production/HTTPS) cookies, `cookieCache` off, and `requireEmailVerification: false`.
- `src/core/` owns `requireAuth` (`401 UnauthorizedError` when unauthenticated, `403 ForbiddenError` if `user.banned`), `requireRole`, `requirePermission` (`403 ForbiddenError`), and OpenAPI `securitySchemes` (`bearerAuth` + `cookieAuth`) applied with OR semantics (`[{ bearerAuth: [] }, { cookieAuth: [] }]`) on protected Feature Module routes.
- `tasks` and `files` default `GET` lists to `userId === user.id` (supporting `?scope=all` / `?userId=<id>` only with `:read:any`), `src/modules/auth/` exposes `GET /me` and `PATCH /me` (`name`, `image` via `AuthPort.updateProfile`), and `src/routes/users/` + `src/routes/auth/auth.routes.ts` + `clonedReq` are retired.
