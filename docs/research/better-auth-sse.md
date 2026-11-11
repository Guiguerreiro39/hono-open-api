# Research: Better Auth RBAC, OpenAPI Integration, and SSE Authentication

- **Ticket:** Wayfinder research ticket #3 (`Guiguerreiro39/hono-open-api`)
- **Stack baseline in repo:** `better-auth@^1.6.25` (locked `1.6.25`), `hono@^4.12.32` (locked `4.12.32`), `@hono/zod-openapi@^1.5.1` (locked `1.5.1`), `@scalar/hono-api-reference@^0.11.11`, `zod@^4.4.3` ([`package.json`](../../package.json), [`pnpm-lock.yaml`](../../pnpm-lock.yaml)).

---

## Executive Summary

1. **Better Auth `1.6.x` `admin` + `access` + `openAPI` plugins eliminate custom auth/user boilerplate:**
   - `admin()` (`better-auth/plugins`) natively manages user CRUD, role assignment, banning, session revocation, and impersonation behind role-based checks, replacing the un-role-checked Drizzle endpoints in [`src/routes/users/`](../../src/routes/users/users.index.ts).
   - `createAccessControl()` (`better-auth/plugins/access`) + `defaultStatements`/`adminAc`/`userAc` (`better-auth/plugins/admin/access`) provide typed resource/action RBAC checkable server-side via `auth.api.userHasPermission(...)` and client-side via `authClient.admin.hasPermission(...)` / `checkRolePermission(...)`.
   - `openAPI()` (`better-auth/plugins`) generates an OpenAPI `3.1.1` spec (`GET /api/auth/open-api/generate-schema` and `auth.api.generateOpenAPISchema()`) plus optional Scalar UI.
2. **The `clonedReq` workaround in [`src/routes/auth/auth.index.ts`](../../src/routes/auth/auth.index.ts) exists solely because `.openapi(...)` consumes `c.req.raw.body`:**
   - `@hono/zod-openapi` compiles `request.body` definitions into validator middleware that reads `c.req.json()` before the handler runs, exhausting the single-use Fetch `Request.body` `ReadableStream` prior to `auth.handler(c.req.raw)`.
   - The official Hono pattern mounts `app.on(["POST", "GET"], "/api/auth/*", (c) => auth.handler(c.req.raw))` directly (no `.openapi()` wrapper, no `clonedReq`, no hand-rolled [`src/routes/auth/auth.routes.ts`](../../src/routes/auth/auth.routes.ts)) and integrates Better Auth docs either via Scalar `sources` (`openAPI({ disableDefaultReference: true })`) or by merging `auth.api.generateOpenAPISchema()` into an OpenAPI `3.1.0` Hono doc (`app.getOpenAPI31Document(...)`).
3. **`client-example.ts` `?token=` fails both security standards and current server auth:**
   - [`src/lib/realtime/client-example.ts`](../../src/lib/realtime/client-example.ts) appends `?token=...` to `new EventSource(fullUrl, { withCredentials: true })`, leaking tokens into logs/history/Referers (RFC 6750 §2.3) while [`src/middlewares/auth.ts`](../../src/middlewares/auth.ts) + Better Auth `bearer()` only read `Authorization: Bearer` headers or session cookies (ignoring `?token=`).
   - Prefer **Better Auth `HttpOnly` session cookies** with `EventSource(..., { withCredentials: true })` (plus strict CORS allowlist + `trustedOrigins` when cross-origin) for browser apps; use **short-lived single-use SSE tickets** when cookies are unavailable with native `EventSource`; or use **`fetch()`-based SSE** (`fetch` + `eventsource-parser` or `@microsoft/fetch-event-source`) when `Authorization: Bearer` headers are required.

---

## 1. Better Auth `1.6.x`: `admin`, `access`, and `openAPI` Plugins

### 1.1 Current Repo Gap

- [`src/lib/auth.ts`](../../src/lib/auth.ts) configures `betterAuth` with `drizzleAdapter(db, { provider: "sqlite", schema })`, `emailAndPassword: { enabled: true }`, and `plugins: [bearer()]`. Neither `admin()` nor `openAPI()` is enabled.
- [`src/routes/users/`](../../src/routes/users/users.handlers.ts) implements manual Drizzle CRUD (`GET /users`, `POST /users`, `GET /users/{id}`, `PATCH /users/{id}`, `DELETE /users/{id}`) behind [`requireAuth`](../../src/middlewares/auth.ts) (`app.use("/users/*", requireAuth)` in [`src/app.ts`](../../src/app.ts)). Any authenticated session—regardless of role—can list, create, modify, or delete arbitrary users, and `POST /users` inserts into `user` without setting a password `account` record.

### 1.2 `admin` Plugin (`better-auth/plugins`)

- **Schema additions** ([`admin.mdx`](https://github.com/better-auth/better-auth/blob/v1.6.23/docs/content/docs/plugins/admin.mdx)):
  - `user` table: `role` (`string | null`, defaults to `"user"`), `banned` (`boolean | null`), `banReason` (`string | null`), `banExpires` (`date | null`).
  - `session` table: `impersonatedBy` (`string | null`, ID of the impersonating admin).
  - Run `npx @better-auth/cli generate` (or update [`src/db/schema.ts`](../../src/db/schema.ts) + Drizzle migrations) after adding `admin()`. Bootstrap an initial admin via `npx auth@latest create-admin` ([`admin.mdx`](https://github.com/better-auth/better-auth/blob/v1.6.23/docs/content/docs/plugins/admin.mdx)).
- **Plugin options** (`admin(options)` in [`admin.mdx`](https://github.com/better-auth/better-auth/blob/v1.6.23/docs/content/docs/plugins/admin.mdx)):
  - `defaultRole`: role assigned on user creation/sign-up (default `"user"`).
  - `adminRoles`: array of role names treated as admin (default `["admin"]`).
  - `adminUserIds`: array of explicit super-admin user IDs granted admin access regardless of `role`.
  - `impersonationSessionDuration`: seconds before impersonation session expires (default `3600` / 1 hour).
  - `defaultBanReason`, `defaultBanExpiresIn` (seconds; `undefined` = permanent), `bannedUserMessage`.
  - `ac` and `roles`: custom `createAccessControl` controller and role definitions.
- **Native endpoints & SDK methods** (relative to Better Auth `basePath`, default `/api/auth`) ([`admin.mdx`](https://github.com/better-auth/better-auth/blob/v1.6.23/docs/content/docs/plugins/admin.mdx), [`docs/1.6/plugins/admin`](https://better-auth.com/docs/1.6/plugins/admin)):

| Operation | HTTP Endpoint | Server API (`auth.api.*`) | Client SDK (`authClient.admin.*`) |
| --- | --- | --- | --- |
| Create user (with password & role) | `POST /admin/create-user` | `createUser` | `createUser` |
| List/search/filter/paginate users | `GET /admin/list-users` | `listUsers` | `listUsers` |
| Fetch user by ID | `GET /admin/get-user` | `getUser` | — |
| Update user data | `POST /admin/update-user` | `adminUpdateUser` | `updateUser` |
| Assign role (`string \| string[]`) | `POST /admin/set-role` | `setRole` | `setRole` |
| Set/reset user password | `POST /admin/set-user-password` | `setUserPassword` | `setUserPassword` |
| Ban user (revokes sessions) | `POST /admin/ban-user` | `banUser` | `banUser` |
| Unban user | `POST /admin/unban-user` | `unbanUser` | `unbanUser` |
| List sessions for user | `POST /admin/list-user-sessions` | `listUserSessions` | `listUserSessions` |
| Revoke single session | `POST /admin/revoke-user-session` | `revokeUserSession` | `revokeUserSession` |
| Revoke all sessions for user | `POST /admin/revoke-user-sessions` | `revokeUserSessions` | `revokeUserSessions` |
| Start impersonating user | `POST /admin/impersonate-user` | `impersonateUser` | `impersonateUser` |
| End impersonation | `POST /admin/stop-impersonating` | `stopImpersonating` | `stopImpersonating` |
| Hard-delete user | `POST /admin/remove-user` | `removeUser` | `removeUser` |
| Check permissions | `POST /admin/has-permission` | `userHasPermission` | `hasPermission` / `checkRolePermission` |

### 1.3 Access Control / RBAC (`better-auth/plugins/access` & `better-auth/plugins/admin/access`)

- **Default statements and roles** ([`packages/better-auth/src/plugins/admin/access/statement.ts`](https://github.com/better-auth/better-auth/blob/main/packages/better-auth/src/plugins/admin/access/statement.ts)):
  - `defaultStatements`:
    - `user`: `["create", "list", "set-role", "ban", "impersonate", "impersonate-admins", "delete", "set-password", "set-email", "get", "update"]`
    - `session`: `["list", "revoke", "delete"]`
  - `adminAc`: `defaultAc.newRole(...)` granting all `user` actions **except** `"impersonate-admins"`, plus all `session` actions (`["list", "revoke", "delete"]`).
  - `userAc`: `defaultAc.newRole({ user: [], session: [] })`.
- **Custom resources & roles** ([`admin.mdx`](https://github.com/better-auth/better-auth/blob/v1.6.23/docs/content/docs/plugins/admin.mdx)):
  - Defining custom `roles` overrides defaults for any existing role name (`admin`, `user`). Always spread `...defaultStatements` into your `statement` (`as const`) and spread `...adminAc.statements` into custom `admin` roles to retain built-in admin capabilities.
  - Pass the same `ac` and `roles` to `admin({ ac, roles })` on the server and `adminClient({ ac, roles })` on the client.
  - Example for `tasks` resource permissions in this repo:
    ```ts
    import { createAccessControl } from "better-auth/plugins/access";
    import { adminAc, defaultStatements, userAc } from "better-auth/plugins/admin/access";

    export const statement = {
      ...defaultStatements,
      task: ["create", "read", "update", "delete"],
    } as const;

    export const ac = createAccessControl(statement);
    export const userRole = ac.newRole({ ...userAc.statements, task: ["create", "read", "update", "delete"] });
    export const adminRole = ac.newRole({ ...adminAc.statements, task: ["create", "read", "update", "delete"] });
    ```
- **Role/permission checks**:
  - **Server-side:** `await auth.api.userHasPermission({ body: { userId: session.user.id, permissions: { task: ["delete"] } } })` (or `{ role: "admin", permissions: ... }`; `role` parameter is `@serverOnly`). Supports checking `permission` or multiple resource `permissions` in one call. Can back a Hono `requirePermission(...)` middleware right after [`requireAuth`](../../src/middlewares/auth.ts).
  - **Client-side:** `await authClient.admin.hasPermission({ permissions })` calls the server endpoint; `authClient.admin.checkRolePermission({ role, permissions })` performs a synchronous check against static client-defined `roles` (does not support dynamic roles).

### 1.4 `openAPI` Plugin (`better-auth/plugins`)

- **What it provides** ([`open-api.mdx`](https://github.com/better-auth/better-auth/blob/v1.6.23/docs/content/docs/plugins/open-api.mdx)):
  - Exposes `GET /api/auth/open-api/generate-schema`, returning an **OpenAPI `3.1.1`** JSON specification covering Better Auth core endpoints, active plugin endpoints (such as `admin`, `bearer`, `oneTimeToken`), and component `Models`.
  - Exposes `await auth.api.generateOpenAPISchema()` programmatically on the server.
  - Hosts a built-in Scalar UI at `path` (default `/api/auth/reference`), customizable via `{ path, disableDefaultReference, theme, nonce }`.
  - *TypeScript note:* If `auth.api.generateOpenAPISchema` fails type inference under certain TS/plugin configurations, verify `openAPI()` is registered directly in `plugins` (or cast `(auth.api as any).generateOpenAPISchema()` if needed; see Better Auth OpenAPI docs/issues).

---

## 2. Clean Hono + `@hono/zod-openapi` Integration (Removing `clonedReq`)

### 2.1 Root Cause of `clonedReq` in [`src/routes/auth/auth.index.ts`](../../src/routes/auth/auth.index.ts)

[`src/routes/auth/auth.index.ts`](../../src/routes/auth/auth.index.ts) currently clones `c.req.raw` in middleware (`c.set("clonedReq", c.req.raw.clone())`) and binds `signUpEmail`, `signInEmail`, `signOut`, `getSession` via `.openapi(route, handleAuth)` before a fallback `.on(["POST", "GET"], "/api/auth/**", ...)`.

Why `clonedReq` was needed:
1. When a `createRoute(...)` defines `request.body` (`content: { "application/json": { schema } }`), `OpenAPIHono.prototype.openapi(...)` automatically registers validation middleware (via `@hono/zod-validator`) that calls `c.req.json()` before your handler executes ([`@hono/zod-openapi` README](https://github.com/honojs/middleware/blob/main/packages/zod-openapi/README.md)).
2. Calling `c.req.json()` reads and consumes the Fetch Web Standard `Request.body` `ReadableStream`, setting `c.req.raw.bodyUsed = true`.
3. Passing the consumed `c.req.raw` into `auth.handler(c.req.raw)` fails (`TypeError: Body has already been used` / `Body is unusable`) because a Fetch `Request` stream can only be read once ([Hono `cloneRawRequest` docs](https://github.com/honojs/hono)).
4. Additionally, [`src/routes/auth/auth.routes.ts`](../../src/routes/auth/auth.routes.ts) hand-rolls Zod schemas for only 4 auth routes, leaving every other Better Auth route (and future `admin` endpoints) undocumented while duplicating Better Auth's internal request validation (and causing `415`/`422` mismatches if Better Auth expects optional fields or headers differently).

### 2.2 Official Hono Mount Pattern

Because both Hono and Better Auth operate on Web Standard `Request`/`Response`, Better Auth's official Hono integration mounts `auth.handler` directly without `@hono/zod-openapi` body validators ([`integrations/hono.mdx`](https://github.com/better-auth/better-auth/blob/v1.6.23/docs/content/docs/integrations/hono.mdx)):

```ts
import { cors } from "hono/cors";
import { auth } from "@/lib/auth";

// Register CORS BEFORE auth routes if serving cross-origin browsers
app.use(
  "/api/auth/*",
  cors({
    origin: "https://app.example.com", // exact origin(s), never "*" with credentials
    allowHeaders: ["Content-Type", "Authorization"],
    allowMethods: ["POST", "GET", "OPTIONS"],
    exposeHeaders: ["Content-Length"],
    maxAge: 600,
    credentials: true,
  }),
);

// Official Hono mount: register before catch-all routes; matches basePath "/api/auth"
app.on(["POST", "GET"], "/api/auth/*", (c) => auth.handler(c.req.raw));
```

Key cleanup notes for this repo:
- Use `"/api/auth/*"` rather than `"/api/auth/**"` (official Better Auth Hono docs use `"*"`).
- Remove `clonedReq` from [`src/routes/auth/auth.index.ts`](../../src/routes/auth/auth.index.ts) and [`src/lib/types.ts`](../../src/lib/types.ts), and delete [`src/routes/auth/auth.routes.ts`](../../src/routes/auth/auth.routes.ts).
- Note on [`src/routes/auth/auth.test.ts`](../../src/routes/auth/auth.test.ts): `testClient(app).api.auth[...]` currently relies on `.openapi(...)` route definitions (which [`src/app.ts`](../../src/app.ts) already excludes from `export type AppType = typeof tasks & typeof users`). After switching to `app.on(...)`, test auth HTTP routes via `app.request("/api/auth/sign-up/email", ...)` or `auth.api.*` / `createAuthClient`.
- *(Note on Hono `cloneRawRequest`)*: Hono v4 also provides `cloneRawRequest(c.req)` (`hono/request`) to rebuild a `Request` from Hono's `bodyCache` after validators run ([Hono docs](https://github.com/honojs/hono)), but Better Auth routes should not pass through `@hono/zod-openapi` validators at all.

### 2.3 OpenAPI Spec Integration Patterns

[`src/lib/configure-open-api.ts`](../../src/lib/configure-open-api.ts) currently exposes `/doc` using OpenAPI **`3.0.0`** (`app.doc("/doc", ...)`) and serves `Scalar({ url: "/doc", ... })` at `/reference`. Two clean patterns integrate Better Auth's `openAPI()` plugin:

#### Option A (Recommended for Docs UI): Scalar Multi-Source (`sources`)
Better Auth's official OpenAPI docs explicitly recommend Scalar's `sources` array ([`open-api.mdx`](https://github.com/better-auth/better-auth/blob/v1.6.23/docs/content/docs/plugins/open-api.mdx), [Scalar Hono configuration](https://github.com/scalar/scalar)):
1. Enable `openAPI({ disableDefaultReference: true })` in [`src/lib/auth.ts`](../../src/lib/auth.ts) so Better Auth serves `/api/auth/open-api/generate-schema` without duplicating `/api/auth/reference`.
2. Update [`src/lib/configure-open-api.ts`](../../src/lib/configure-open-api.ts) to pass `sources` to `Scalar(...)`:
   ```ts
   app.get(
     "/reference",
     Scalar({
       pageTitle: "Tasks API",
       theme: "kepler",
       layout: "classic",
       sources: [
         { title: "API", url: "/doc" },
         { title: "Auth", url: "/api/auth/open-api/generate-schema" },
       ],
     }),
   );
   ```
- **Pros:** Zero OpenAPI version mismatch (`3.0.0` in `/doc` vs `3.1.1` from Better Auth), zero path rewriting, automatically documents `admin` and any future Better Auth plugins.

#### Option B (For Monolithic Codegen Clients): Single Merged OpenAPI `3.1.0` Document
If downstream tools (`openapi-typescript`, `orval`, etc.) require one JSON file at `/doc`:
1. Switch Hono from OpenAPI `3.0.0` (`app.doc`) to OpenAPI `3.1.0` (`app.getOpenAPI31Document(...)`) so JSON Schema versions align with Better Auth's `3.1.1` output ([`@hono/zod-openapi` README](https://github.com/honojs/middleware/blob/main/packages/zod-openapi/README.md)).
2. Call `const authSpec = await auth.api.generateOpenAPISchema()` (with `openAPI({ disableDefaultReference: true })`), inspect whether `authSpec.paths` are relative to `basePath` (e.g., `/sign-in/email` under `servers: [{ url: ".../api/auth" }]`) and prepend `/api/auth` (`pathModification: { prepend: "/api/auth" }` via `openapi-merge` or object key mapping), and merge `paths`, `components.schemas`, `components.securitySchemes`, and `tags` inside a `/doc` route handler (caching the merged result).

---

## 3. Authenticating Browser `EventSource` SSE Connections

### 3.1 Constraints & Current Repo Bug

- **WHATWG `EventSource` API limitation:** `new EventSource(url, { withCredentials })` only supports HTTP `GET` and **does not allow custom HTTP headers** such as `Authorization: Bearer <token>` ([WHATWG SSE Standard](https://html.spec.whatwg.org/multipage/server-sent-events.html), [MDN `EventSource`](https://developer.mozilla.org/en-US/docs/Web/API/EventSource)).
- **RFC 6750 §2.3 & OWASP URL token warning:** Passing bearer tokens in query parameters (`?token=...`) is explicitly discouraged unless no header/body option exists, because URLs leak into server/reverse-proxy access logs, browser history, `Referer` headers, and telemetry ([RFC 6750 §2.3](https://datatracker.ietf.org/doc/html/rfc6750), [OWASP HTML5 Security Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/HTML5_Security_Cheat_Sheet.html)).
- **Current mismatch in repo:** [`src/lib/realtime/client-example.ts`](../../src/lib/realtime/client-example.ts) constructs `new EventSource(\`\${url}?token=\${encodeURIComponent(token)}\`, { withCredentials: true })`, whereas [`src/middlewares/auth.ts`](../../src/middlewares/auth.ts) calls `auth.api.getSession({ headers: c.req.raw.headers })` (which reads Better Auth session cookies or `Authorization: Bearer` headers via `bearer()`—it does **not** read `?token=`). Passing `token` without a cookie fails with `401 Unauthorized` on [`GET /tasks/live`](../../src/routes/tasks/tasks.routes.ts).
- **HTTP/1.1 connection limit:** Browsers cap HTTP/1.1 connections at **6 concurrent connections per origin** across tabs; multiple `EventSource` streams block other API calls unless served over **HTTP/2** multiplexing ([MDN `EventSource`](https://developer.mozilla.org/en-US/docs/Web/API/EventSource)).

### 3.2 Option Comparison

| Approach | Transport / Client | Auth Mechanism | Security & Reliability Tradeoffs |
| --- | --- | --- | --- |
| **1. Session Cookies + `withCredentials`** | Native `EventSource(url, { withCredentials: true })` | Better Auth `HttpOnly` session cookie | **Best for browser UIs.** Zero URL secret leakage; native auto-reconnect + `Last-Event-ID`; works out of the box with `requireAuth`. Cross-origin requires exact CORS `origin` + `credentials: true` ([`hono/cors`](https://hono.dev/docs/middleware/builtin/cors)), `trustedOrigins`, and `sameSite: "none"; secure: true; partitioned: true` ([`integrations/hono.mdx`](https://github.com/better-auth/better-auth/blob/v1.6.23/docs/content/docs/integrations/hono.mdx)), which can still be blocked by strict third-party cookie settings unless same-site/proxied. |
| **2. Short-Lived Single-Use SSE Ticket** | Native `EventSource("/tasks/live?ticket=...")` after `POST /sse/ticket` | Authenticated `POST` mints opaque CSPRNG ticket (e.g. 15–30s TTL, bound to `userId`), deleted atomically on first `GET` | **Best when cookies cannot be sent to native `EventSource`**. If logged, ticket is already consumed and never exposes the long-lived session/bearer token. **Caveat:** native `EventSource` reconnects to the *same URL*, so a consumed ticket returns `401` on reconnect unless the client intercepts `onerror`, closes, and fetches a new ticket. *(Better Auth's [`oneTimeToken`](https://github.com/better-auth/better-auth/blob/v1.6.23/docs/content/docs/plugins/one-time-token.mdx) plugin implements single-use session tokens consumed via `auth.api.verifyOneTimeToken({ body: { token } })`, though a dedicated short-TTL SSE-only ticket avoids granting full-session exchange power.)* |
| **3. `fetch()`-based SSE Stream** | `fetch()` + [`eventsource-parser`](https://github.com/rexxars/eventsource-parser) (or [`@microsoft/fetch-event-source`](https://github.com/Azure/fetch-event-source)) | Standard `Authorization: Bearer <token>` header | **Best for Bearer-only / mobile / SPA cross-origin clients without cookies.** Works directly with `bearer()` + `requireAuth` (`headers: { Authorization: \`Bearer \${token}\` }`); supports `POST`, token refresh on `401`, and `AbortController`. **Caveats:** `@microsoft/fetch-event-source` (`v2.0.1`, Apr 2021) is effectively unmaintained (last release 2021); prefer native `fetch` + actively maintained `eventsource-parser` (`EventSourceParserStream`), and implement `Last-Event-ID` / retry backoff explicitly. |

### 3.3 Recommended SSE Auth Architecture for This Repo

1. **Primary browser pattern:** Keep [`src/middlewares/auth.ts`](../../src/middlewares/auth.ts) using `auth.api.getSession({ headers: c.req.raw.headers })` (which already validates Better Auth `HttpOnly` session cookies and `Authorization: Bearer` headers). Serve API and SPA same-site (or via reverse proxy / `crossSubDomainCookies`) or configure `hono/cors` (`credentials: true`, explicit `origin`) + `trustedOrigins` + `defaultCookieAttributes` for cross-origin `EventSource(url, { withCredentials: true })`.
2. **Update [`src/lib/realtime/client-example.ts`](../../src/lib/realtime/client-example.ts):** Remove `?token=` from `EventSource` entirely. Either:
   - Default to cookie-authenticated `new EventSource(url, { withCredentials: true })` (no `token` parameter in URL), or
   - When `headers` / `token` is supplied, stream via `fetch(url, { headers: { Authorization: \`Bearer \${token}\` }, signal })` piped through `eventsource-parser` (`EventSourceParserStream`) instead of `EventSource`.
3. **If native `EventSource` is mandatory in a cookie-less cross-origin environment:** Add an authenticated `POST /sse/ticket` endpoint generating a 30-second single-use CSPRNG ticket consumed atomically inside `GET /tasks/live`, and wrap `EventSource` reconnection in the client helper to mint a new ticket before re-subscribing.
4. **Hardening per OWASP & Hono [`streamSSE`](https://github.com/honojs/hono/blob/main/src/helper/streaming/sse.ts):**
   - Validate `EventSource` target URLs and `event.origin` on the client; treat `event.data` strictly as JSON data, never HTML/code ([OWASP HTML5 Security Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/HTML5_Security_Cheat_Sheet.html)).
   - Emit `id:` in [`stream.writeSSE`](../../src/lib/realtime/sse.ts) if missed-event replay via `Last-Event-ID` is added later, and deploy behind HTTP/2 to avoid the 6-connection-per-origin HTTP/1.1 cap.

---

## Primary Sources Cited

- Better Auth v1.6 Admin Plugin Docs: <https://github.com/better-auth/better-auth/blob/v1.6.23/docs/content/docs/plugins/admin.mdx> and <https://better-auth.com/docs/1.6/plugins/admin>
- Better Auth Admin Access Control Statements Source: <https://github.com/better-auth/better-auth/blob/main/packages/better-auth/src/plugins/admin/access/statement.ts>
- Better Auth v1.6 OpenAPI Plugin Docs: <https://github.com/better-auth/better-auth/blob/v1.6.23/docs/content/docs/plugins/open-api.mdx> and <https://better-auth.com/docs/1.6/plugins/open-api>
- Better Auth v1.6 Hono Integration Docs: <https://github.com/better-auth/better-auth/blob/v1.6.23/docs/content/docs/integrations/hono.mdx>
- Better Auth v1.6 Bearer Plugin Docs: <https://better-auth.com/docs/1.6/plugins/bearer>
- Better Auth v1.6 One-Time Token Plugin Docs: <https://github.com/better-auth/better-auth/blob/v1.6.23/docs/content/docs/plugins/one-time-token.mdx>
- Better Auth v1.6 Cookies & Options Docs: <https://github.com/better-auth/better-auth/blob/v1.6.23/docs/content/docs/concepts/cookies.mdx> and <https://github.com/better-auth/better-auth/blob/v1.6.23/docs/content/docs/reference/options.mdx>
- `@hono/zod-openapi` README (`honojs/middleware`): <https://github.com/honojs/middleware/blob/main/packages/zod-openapi/README.md>
- Hono Core (`cloneRawRequest`, `cors`, `streamSSE`): <https://github.com/honojs/hono>, <https://hono.dev/docs/middleware/builtin/cors>, <https://github.com/honojs/hono/blob/main/src/helper/streaming/sse.ts>
- Scalar API Reference (`@scalar/hono-api-reference`): <https://github.com/scalar/scalar>
- WHATWG HTML Living Standard (Server-Sent Events): <https://html.spec.whatwg.org/multipage/server-sent-events.html>
- MDN Web Docs (`EventSource`): <https://developer.mozilla.org/en-US/docs/Web/API/EventSource>
- IETF RFC 6750 §2.3 (OAuth 2.0 Bearer Token Usage — URI Query Parameter): <https://datatracker.ietf.org/doc/html/rfc6750>
- OWASP HTML5 Security Cheat Sheet: <https://cheatsheetseries.owasp.org/cheatsheets/HTML5_Security_Cheat_Sheet.html>
- Fetch-based SSE Client / Parser Repos: <https://github.com/Azure/fetch-event-source>, <https://github.com/rexxars/eventsource-parser>
