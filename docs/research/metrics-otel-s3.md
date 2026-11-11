# Research: Prometheus Metrics, OpenTelemetry Hooks, and S3 Object Storage SDKs

**Ticket:** Wayfinder #5  
**Target Stack:** Node.js ESM (`"type": "module"`), TypeScript `~5.9.3` (`moduleResolution: "Bundler"`), Hono `^4.12.32` (`@hono/node-server`, `@hono/zod-openapi`), `hono-pino` `^0.10.3`, `pino` `^10.3.1`, Vitest `^4.1.10`.

---

## Executive Summary

1. **Prometheus Metrics (`prom-client` directly over `@hono/prometheus`):** Use `prom-client` directly with a module-scoped `Registry`, Hono's `routePath(c)` / `matchedRoutes(c)` from `hono/route` (since `c.req.routePath` was deprecated in Hono 4.8.0 and removed in v5), early-return exclusion for `/metrics`, and a dedicated `Gauge` + duration exclusion for the `/tasks/live` SSE endpoint (`streamSSE` resolves `await next()` at TTFB, not stream close).
2. **Trace Propagation (`W3C traceparent` + `hono-pino` + optional `AsyncLocalStorage`):** Installing `@opentelemetry/api` alone is a **no-op** for root requests and `async`/`await` propagation without registering a `TracerProvider` and `AsyncLocalStorageContextManager`. For zero-collector local dev today, parse/generate W3C `traceparent` in a lightweight Hono middleware and bind `trace_id`/`span_id` onto `c.var.logger.assign(...)` (plus `AsyncLocalStorage` + Pino `mixin()` if non-Hono modules log directly). Upgrade cleanly to `@hono/otel` + `@opentelemetry/sdk-trace-base` (`BasicTracerProvider` without exporters) when spans are needed.
3. **S3 Storage (`@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner` + `@aws-sdk/lib-storage`):** Prefer AWS SDK v3 over `aws4fetch` and `minio` for Node.js ESM backends targeting AWS S3, Cloudflare R2, and local S3-compatible servers (`forcePathStyle: true`). **Crucial caveat:** AWS SDK v3 `>= 3.729.0` defaults `requestChecksumCalculation` to `"WHEN_SUPPORTED"`, which injects CRC32/aws-chunked trailers that break R2, MinIO, and browser presigned PUTs—explicitly set `requestChecksumCalculation: "WHEN_REQUIRED"` and `responseChecksumValidation: "WHEN_REQUIRED"`. Also note upstream `minio/minio` was archived on **April 25, 2026** (official community Docker images halted Oct 2025), making **RustFS** / **SeaweedFS** / **LocalStack** safer choices for new local S3 dev parity.

---

## Repo Alignment Baseline

Observed in local repository files:
- [`package.json`](../../package.json): `"type": "module"`, `hono@^4.12.32`, `@hono/node-server@^2.0.12`, `@hono/zod-openapi@^1.5.1`, `hono-pino@^0.10.3`, `pino@^10.3.1`, `vitest@^4.1.10`.
- [`tsconfig.json`](../../tsconfig.json): `"module": "ESNext"`, `"moduleResolution": "Bundler"`, `"strict": true`, `"types": ["node"]`.
- [`src/lib/create-app.ts`](../../src/lib/create-app.ts): `createApp()` wires `OpenAPIHono<AppBindings>` with `requestId()`, `serveEmojiFavicon("📝")`, `pinoLogger()`, `notFound`, and `onError`. `createTestApp()` invokes `createApp()` repeatedly across test suites.
- [`src/middlewares/pino-logger.ts`](../../src/middlewares/pino-logger.ts): passes a `pino(...)` root logger instance into `hono-pino`'s `pinoLogger(...)`.
- [`src/routes/tasks/tasks.routes.ts`](../../src/routes/tasks/tasks.routes.ts) & [`src/lib/realtime/sse.ts`](../../src/lib/realtime/sse.ts): OpenAPI route parameters use `{id}` (compiled by `@hono/zod-openapi` into `:id`), and `GET /tasks/live` returns `streamSSE(...)` (`text/event-stream`) with a 15s heartbeat loop until client abort.

---

## 1. Prometheus Metrics in Hono (`prom-client` vs `@hono/prometheus`)

### Comparison

| Capability | `prom-client` directly | `@hono/prometheus` |
| --- | --- | --- |
| Primary source | [`prometheus/client_js` README](https://github.com/prometheus/client_js/blob/v15.1.3/README.md) | [`@hono/prometheus` README](https://github.com/honojs/middleware/blob/main/packages/prometheus/README.md) |
| Dependencies | `prom-client` only | `@hono/prometheus` + `prom-client` |
| Route-exclusion (`/metrics`, `/doc`, `/reference`) | Native early return before timing/counting | No documented ignore/skip option in `prometheus(options?)`; requires wrapping `registerMetrics` |
| SSE (`/tasks/live`) handling | Full control (skip duration histogram, add `Gauge` for active connections) | Records `http_request_duration_seconds` and `http_requests_total` on every matched request |
| Metric schema & labels | Full control (custom buckets, drop unused `ok` label, OpenMetrics exemplars) | Fixed `http_request_duration_seconds` & `http_requests_total` (`method`, `route`, `status`, `ok`) + `customLabels` |
| 404 cardinality control | Explicit `matchedRoutes(c)` inspection (`"__unmatched__"`) | Depends on internal route extraction |

**Recommendation:** Use **`prom-client` directly** in a small Hono middleware module (`~50` lines).

### Route-Template Path Normalization (`hono/route`)

1. **Avoid deprecated APIs:** `c.req.routePath` and `c.req.matchedRoutes` were deprecated in Hono `v4.8.0` and removed in Hono `v5` ([Hono Request API](https://hono.dev/docs/api/request), [Migrating to v5](https://hono.dev/docs/guides/migrating-to-v5)). Always import `routePath` and `matchedRoutes` from `"hono/route"` ([Hono Route Helper](https://hono.dev/docs/helpers/route)).
2. **Resolve after `await next()`:** Per Hono's `hono/route` helper contract (`src/helper/route/index.ts`), `routePath(c, index?)` defaults `index` to `c.req.routeIndex` ([`honojs/hono`](https://github.com/honojs/hono)). Inside a global `app.use("*", ...)` middleware, `c.req.routeIndex` points to the middleware itself (`"*"`) *before* `await next()`, and advances through downstream handlers during `await next()`.
3. **Prevent 404 cardinality explosions:** When no concrete endpoint matches (404), `matchedRoutes(c)` contains only middleware routes (`method === "ALL"`, e.g. `"*"`, `"/tasks/*"`). Never fall back to raw `c.req.path` (which turns scanner traffic like `/wp-login.php` or `/tasks/99999/bad` into unbounded Prometheus time series). Instead, inspect `matchedRoutes(c)` after `await next()`:

```ts
import { matchedRoutes, routePath } from "hono/route";

function resolveRouteLabel(c: Context): string {
  const endpoint = matchedRoutes(c).findLast((r) => r.method !== "ALL");
  if (endpoint) return endpoint.path; // e.g. "/tasks/:id" (compiled from "/tasks/{id}")
  if (c.res.status === 404) return "__unmatched__";
  const path = routePath(c, -1);
  return path === "*" ? "__unmatched__" : path;
}
```

### Excluding `/metrics` and Handling Long-Lived SSE (`/tasks/live`)

- **Exclude `/metrics` (and optionally `/doc`, `/reference`, `/favicon.ico`):** Short-circuit at the top of the metrics middleware (`if (c.req.path === "/metrics") return next();`) so Prometheus scrape traffic does not inflate `http_requests_total` or skew latency histograms. Because [`src/app.ts`](../../src/app.ts) only mounts `requireAuth` on `/tasks*` and `/users*`, protect `/metrics` via internal-only port/reverse-proxy rules or bearer auth if publicly reachable.
- **SSE (`GET /tasks/live`) timing semantics in Hono:** Per Hono's [`sse.ts`](https://github.com/honojs/hono/blob/main/src/helper/streaming/sse.ts) and [`sse.test.tsx`](https://github.com/honojs/hono/blob/main/src/helper/streaming/sse.test.tsx), `streamSSE(c, cb)` returns the `200 text/event-stream` `Response` immediately while `cb(stream)` runs asynchronously in the background until `stream.close()` / abort. Therefore, `await next()` resolves at **time-to-headers (sub-millisecond)**—*not* when the SSE connection closes.
  - Skip `http_request_duration_seconds.observe(...)` when `c.res.headers.get("content-type")?.includes("text/event-stream")` (or when route === `"/tasks/live"`).
  - Track live SSE streams inside [`src/lib/realtime/sse.ts`](../../src/lib/realtime/sse.ts) with a `prom-client` `Gauge` (`sse_active_connections`) incremented when `streamSSE` starts and decremented once (guarded by a boolean) in `stream.onAbort` / `finally`, plus an optional `Counter` (`sse_connections_total`).

### `collectDefaultMetrics()` and Vitest / Node.js ESM Caveats

- **Scrape-time evaluation:** Per [`prom-client` v15.1.3 docs](https://github.com/prometheus/client_js/blob/v15.1.3/README.md), default process/Node.js metrics (`process_cpu_*`, `process_resident_memory_bytes`, `nodejs_heap_*`, `nodejs_event_loop_lag_*`, `nodejs_gc_duration_seconds`, `nodejs_active_handles_total`) are computed **on scrape** (`await registry.metrics()`), rather than via an aggressive polling interval—aside from lightweight event-loop lag sampling (`eventLoopMonitoringPrecision`, default `10` ms) and GC observers.
- **Custom `Registry` + `createTestApp()` safety:** Do **not** register `new Counter(...)` / `collectDefaultMetrics()` against the global registry inside `createApp()`; calling `createTestApp()` across multiple Vitest tests will throw `Error: A metric with the name ... has already been registered` ([`prom-client` Registry docs](https://github.com/prometheus/client_js/blob/v15.1.3/README.md)). Create a dedicated module-level `Registry` (or inject an optional `Registry` into `createApp()`), pass `{ register: registry }` to `collectDefaultMetrics` and `registers: [registry]` to metrics, and guard `collectDefaultMetrics` off when `env.NODE_ENV === "test"` so Vitest exits cleanly without active event-loop timers.
- **Node.js ESM import:** `import { collectDefaultMetrics, Counter, Gauge, Histogram, Registry } from "prom-client";` works directly under `"type": "module"`, and the `/metrics` route returns `c.text(await registry.metrics(), 200, { "Content-Type": registry.contentType })`.

---

## 2. Lightweight W3C `traceparent` / OTel Context Propagation Hooks in Hono + Pino

### W3C `traceparent` Specification

Per the [W3C Trace Context specification](https://www.w3.org/TR/trace-context/), `traceparent` has four hyphen-separated lowercase-hex fields:
```text
00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01
│  │                                │                └─ trace-flags (2 hex, bit 0: 01=sampled, 00=unsampled)
│  │                                └─ parent-id (16 hex / 8 bytes; all-zero invalid)
│  └─ trace-id (32 hex / 16 bytes; all-zero invalid)
└─ version (2 hex; current="00", "ff" invalid)
```

### Critical Trap: `@opentelemetry/api` Without an SDK

Per OpenTelemetry JS source and docs ([`sdk-registration.md`](https://github.com/open-telemetry/opentelemetry-js/blob/main/doc/sdk-registration.md), [`context` docs](https://opentelemetry.io/docs/languages/js/context/index.md), [`W3CTraceContextPropagator.ts`](https://github.com/open-telemetry/opentelemetry-js/blob/main/packages/opentelemetry-core/src/trace/W3CTraceContextPropagator.ts)):
1. Without registering `AsyncLocalStorageContextManager` (`@opentelemetry/context-async-hooks`), `@opentelemetry/api` defaults to `NoopContextManager`, so `context.with(...)` **does not** persist across `await` boundaries.
2. Without registering a `TracerProvider` (`BasicTracerProvider` / `NodeTracerProvider`), `trace.getTracer(...).startActiveSpan(...)` returns a `NonRecordingSpan` with all-zero `INVALID_SPAN_CONTEXT` whenever no incoming `traceparent` header is present.

### Approach A (Recommended Now): Zero-Collector Lightweight W3C Hook + `hono-pino`

Requires **zero** OpenTelemetry packages and **no** collector in local dev, integrating directly with [`src/lib/create-app.ts`](../../src/lib/create-app.ts) and [`src/middlewares/pino-logger.ts`](../../src/middlewares/pino-logger.ts):

1. **Middleware ordering & `requestId()`:** `createApp()` already mounts `requestId()` before `pinoLogger()`. Per [`hono-pino` configuration docs](https://github.com/maou-shonen/hono-pino/blob/main/_autodocs/configuration.md), `hono-pino` defaults `referRequestIdKey: "requestId"`, automatically binding `c.var.requestId` into `reqId` on all logs (note: `hono-pino` uses `referRequestIdKey` and `onReqBindings`, *not* `pino-http`'s `genReqId`).
2. **Parse or mint W3C IDs:** A lightweight middleware reads `c.req.header("traceparent")` with regex `/^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/`, rejecting `version === "ff"`, all-zero `traceId`, and all-zero `parentId`. On valid input, preserve `traceId`, set `parentSpanId = parentId`, and generate a fresh 8-byte `spanId` (`randomBytes(8).toString("hex")`); otherwise mint a fresh 16-byte `traceId` and 8-byte `spanId` (`traceFlags = "01"`).
3. **Bind to `hono-pino` child logger:** Calling `c.var.logger.assign({ trace_id: traceId, span_id: spanId })` updates `PinoLogger`'s internal child logger (`this._rootLogger.child(this.#bindings)` per [`PinoLogger.md`](https://github.com/maou-shonen/hono-pino/blob/main/_autodocs/api-reference/PinoLogger.md)), guaranteeing every downstream handler log and the `"Request completed"` response log carry `trace_id` and `span_id`. Alternatively, pass `http: { onReqBindings: (c) => ... }` if the trace middleware runs *before* `pinoLogger()`.
4. **Propagating outside Hono handlers (`AsyncLocalStorage` + Pino `mixin`):** If DB repositories or services log without `c`, wrap `await next()` in a `node:async_hooks` `AsyncLocalStorage` (or Hono's [`contextStorage()`](https://hono.dev/docs/middleware/builtin/context-storage) + `tryGetContext()`) and configure `mixin()` on the root `pino(...)` instance in [`src/middlewares/pino-logger.ts`](../../src/middlewares/pino-logger.ts):
   - Per [`pino` v10.3.1 docs](https://github.com/pinojs/pino/blob/v10.3.1/docs/api.md), `mixin()` runs synchronously on every log call and **must return a fresh object** (Pino mutates the returned object for performance).
   - **SSE caveat (`/tasks/live`):** `pubsub.subscribe` and `setInterval` created inside `streamSSE` retain the `AsyncLocalStorage` context active at subscription time, whereas `pubsub.publish` runs inside the mutating request's context. Keep `trace_id` log correlation per-HTTP request and avoid mutating shared trace stores inside SSE callbacks.

### Approach B (Upgrade Path): `@hono/otel` + `BasicTracerProvider` Without a Collector

When ready for full spans without running an OTel Collector locally:
- Install `@hono/otel`, `@opentelemetry/api`, `@opentelemetry/core`, `@opentelemetry/context-async-hooks`, and `@opentelemetry/sdk-trace-base` ([OpenTelemetry JS Instrumentation](https://opentelemetry.io/docs/languages/js/instrumentation/), [`@hono/otel`](https://github.com/honojs/middleware/blob/main/packages/otel/src/index.ts)).
- Register `AsyncLocalStorageContextManager`, `W3CTraceContextPropagator`, and `new BasicTracerProvider({ spanProcessors: [] })` (omit exporters when `OTEL_EXPORTER_OTLP_ENDPOINT` is unset, or attach `ConsoleSpanExporter` only when debugging). Spans get valid W3C `traceId`/`spanId` locally and silently drop; Pino's `mixin()` simply reads `trace.getActiveSpan()?.spanContext()`.

---

## 3. S3-Compatible Object Storage SDKs (Node.js ESM)

### SDK Comparison

| Dimension | `@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner` (+ `@aws-sdk/lib-storage`) | `aws4fetch` (`v1.0.20`) | `minio` (`minio-js`) |
| --- | --- | --- | --- |
| Primary source | [`aws-sdk-js-v3`](https://github.com/aws/aws-sdk-js-v3/blob/main/packages/s3-request-presigner/README.md) | [`mhart/aws4fetch`](https://github.com/mhart/aws4fetch/blob/v1.0.20/README.md) | [`minio/minio-js`](https://github.com/minio/minio-js/blob/master/_autodocs/api-reference/overview.md) |
| Node.js ESM & TS | Native ESM + full typed S3 commands/errors | Native ESM + TS (`fetch` + `SubtleCrypto`, ~6.4 KB min) | Dual CJS/ESM (`./dist/esm/minio.mjs`); namespace import `import * as Minio from "minio"` |
| AWS S3 / R2 / MinIO parity | First-class (`forcePathStyle`, `region: "auto"`, custom `endpoint`) | Manual URL path-style vs virtual-host construction | Defaults `pathStyle: true`; Node `http`/`https` transport; region probing if `region` omitted |
| Presigned PUT/GET URLs | `getSignedUrl(client, command, { expiresIn, unhoistableHeaders })` | `client.sign(new Request("...?X-Amz-Expires=3600"), { aws: { signQuery: true } })` | `presignedGetObject` / `presignedPutObject` (less ergonomic for enforcing `Content-Type` / `x-amz-*` headers) |
| Streaming uploads (unknown length / >5 GB) | `Upload` (`@aws-sdk/lib-storage`) handles automatic multipart streaming | Single-PUT `fetch` (`duplex: "half"` in Node); no multipart helper; unknown-length streams risk `411` or buffering | `putObject(bucket, key, stream, size?)` auto-multiparts (default 64 MiB `partSize`) |
| Streaming downloads | `GetObjectCommand` `Body.transformToWebStream()` / `Readable` | Standard `fetch` `Response.body` (`ReadableStream`) | `getObject()` returns Node `stream.Readable` |

**Recommendation:** Adopt **`@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner`** (plus **`@aws-sdk/lib-storage`** if streaming unknown-length/large server-proxied uploads). Reserve `aws4fetch` for Edge/Cloudflare Worker runtimes where bundle size prohibits AWS SDK v3.

### Critical Compatibility Configuration (AWS S3, Cloudflare R2, MinIO)

1. **AWS SDK v3 `>= 3.729.0` Flexible Checksums Trap:** Starting in v3.729.0, `@aws-sdk/client-s3` defaults `requestChecksumCalculation` and `responseChecksumValidation` to `"WHEN_SUPPORTED"`, automatically injecting `x-amz-checksum-crc32` / `aws-chunked` trailers on `PutObject` and `UploadPart` ([`flexibleChecksumsMiddleware.ts`](https://github.com/aws/aws-sdk-js-v3/blob/main/packages-internal/checksums/src/submodules/flexible-checksums/flexibleChecksumsMiddleware.ts), [`CLIENTS.md`](https://github.com/aws/aws-sdk-js-v3/blob/main/supplemental-docs/CLIENTS.md), [Issue #6810](https://github.com/aws/aws-sdk-js-v3/issues/6810)). This causes `501 Not Implemented`, signature mismatches, or browser CORS/checksum failures on Cloudflare R2, MinIO, and presigned `PUT` URLs. **Always configure:**

```ts
import { S3Client } from "@aws-sdk/client-s3";

export const s3 = new S3Client({
  region: env.S3_REGION, // "us-east-1" (AWS/MinIO) or "auto" (Cloudflare R2)
  endpoint: env.S3_ENDPOINT, // undefined for AWS; "https://<ACCOUNT_ID>.r2.cloudflarestorage.com" for R2; "http://127.0.0.1:9000" for local
  forcePathStyle: env.S3_FORCE_PATH_STYLE, // true for MinIO/local S3; false for AWS
  credentials: {
    accessKeyId: env.S3_ACCESS_KEY_ID,
    secretAccessKey: env.S3_SECRET_ACCESS_KEY,
  },
  requestChecksumCalculation: "WHEN_REQUIRED",
  responseChecksumValidation: "WHEN_REQUIRED",
});
```

2. **Provider Specifics:**
   - **Cloudflare R2:** Requires `region: "auto"` and `endpoint: https://<ACCOUNT_ID>.r2.cloudflarestorage.com` ([Cloudflare R2 AWS SDK v3 guide](https://developers.cloudflare.com/r2/examples/aws/aws-sdk-js-v3/)). R2 supports both virtual-hosted (`<bucket>.<account>.r2.cloudflarestorage.com`) and path-style (`<account>.r2.cloudflarestorage.com/<bucket>`) URLs ([R2 S3 API docs](https://developers.cloudflare.com/r2/api/s3/api/)). Browser direct uploads via presigned URLs require an R2 bucket CORS policy ([R2 Presigned URLs docs](https://developers.cloudflare.com/r2/api/s3/presigned-urls/)).
   - **MinIO / Local S3:** Set `forcePathStyle: true` so keys resolve to `http://host:port/bucket/key` rather than `<bucket>.host:port` ([`S3.spec.ts`](https://github.com/aws/aws-sdk-js-v3/blob/main/clients/client-s3/test/unit/S3.spec.ts)).

### Presigned URLs and Streaming Patterns

- **Presigned PUT / GET (`@aws-sdk/s3-request-presigner`):**
  - `getSignedUrl(s3, command, { expiresIn: 900 })` defaults `expiresIn` to `900`s (max 7 days = `604800`s on AWS S3 and R2).
  - Setting `ContentType` on `PutObjectCommand` signs the header so clients must send a matching `Content-Type`. Any signed `x-amz-*` headers (e.g., `ChecksumSHA256`) must be listed in `unhoistableHeaders: new Set(["x-amz-checksum-sha256"])` ([`s3-request-presigner` README](https://github.com/aws/aws-sdk-js-v3/blob/main/packages/s3-request-presigner/README.md)).
  - Note on `aws4fetch` if ever used on Workers: pass `X-Amz-Expires=3600` as a URL query parameter (not in `aws` options) alongside `{ aws: { signQuery: true } }` ([Cloudflare R2 `aws4fetch` guide](https://developers.cloudflare.com/r2/examples/aws/aws4fetch/)).
- **Streaming Uploads & Downloads:**
  - **Uploads:** `PutObjectCommand` accepts `Buffer`, `Uint8Array`, `string`, or a stream with known `ContentLength` ([`PutObjectCommand.ts`](https://github.com/aws/aws-sdk-js-v3/blob/main/clients/client-s3/src/commands/PutObjectCommand.ts)). For unknown-length Node.js `Readable` or Web `ReadableStream` uploads (or payloads >5 GB), use `new Upload({ client: s3, params: { Bucket, Key, Body, ContentType }, partSize: 5 * 1024 * 1024, queueSize: 4 }).done()` from `@aws-sdk/lib-storage`.
  - **Downloads:** Per [`EFFECTIVE_PRACTICES.md`](https://github.com/aws/aws-sdk-js-v3/blob/main/supplemental-docs/EFFECTIVE_PRACTICES.md), a `GetObjectCommand` response `Body` stream can only be read once and **must** be buffered (`transformToByteArray()`), piped (`transformToWebStream()` directly into a Hono `Response`), or explicitly discarded (`Body.destroy()` / `Body.cancel()`) to prevent Node.js HTTP socket leaks.

### Dev & Test Parity (2026 Ecosystem Reality)

- **MinIO Upstream Archival:** The upstream [`minio/minio`](https://github.com/minio/minio) repository was **archived read-only on April 25, 2026** (following removal of community binaries/Docker images in Oct 2025). While existing pinned MinIO images still work for legacy setups with `forcePathStyle: true`, new local dev Compose files should prefer an actively maintained Apache-2.0 S3-compatible server such as **RustFS** (`rustfs/rustfs`), **SeaweedFS**, **Garage**, or **LocalStack** (if AWS IAM/SQS triggers are needed)—all spoken to identically by `@aws-sdk/client-s3` with `forcePathStyle: true`.
- **Vitest Test Strategy:** Wrap `S3Client` + `getSignedUrl` + `Upload` behind a narrow `ObjectStorage` interface in `src/lib/storage/`. Use an in-memory/temp-fs fake (or `aws-sdk-client-mock`) for fast unit tests (`npm test`), and run an optional integration suite against the local S3 container to verify real `forcePathStyle: true` presigned `PUT`/`GET` roundtrips and streaming cleanup.

---

## Primary Sources Cited

- Hono Route Helper: https://hono.dev/docs/helpers/route
- Hono Request API (`c.req.routePath` deprecation): https://hono.dev/docs/api/request
- Hono v5 Migration Guide: https://hono.dev/docs/guides/migrating-to-v5
- Hono Context Storage Middleware: https://hono.dev/docs/middleware/builtin/context-storage
- Hono Repository & SSE Streaming Helper: https://github.com/honojs/hono, https://github.com/honojs/hono/blob/main/src/helper/streaming/sse.ts, https://github.com/honojs/hono/blob/main/src/helper/streaming/sse.test.tsx
- Hono Request ID Middleware: https://github.com/honojs/hono/blob/main/src/middleware/request-id/request-id.ts
- `@hono/prometheus` README: https://github.com/honojs/middleware/blob/main/packages/prometheus/README.md
- `@hono/otel` Source: https://github.com/honojs/middleware/blob/main/packages/otel/src/index.ts
- `prom-client` v15.1.3 README: https://github.com/prometheus/client_js/blob/v15.1.3/README.md
- `hono-pino` Docs: https://github.com/maou-shonen/hono-pino/blob/main/_autodocs/api-reference/pinoLogger.md, https://github.com/maou-shonen/hono-pino/blob/main/_autodocs/api-reference/PinoLogger.md, https://github.com/maou-shonen/hono-pino/blob/main/_autodocs/configuration.md
- `pino` v10.3.1 API Docs: https://github.com/pinojs/pino/blob/v10.3.1/docs/api.md
- W3C Trace Context Specification: https://www.w3.org/TR/trace-context/
- OpenTelemetry JS: https://github.com/open-telemetry/opentelemetry-js/blob/main/packages/opentelemetry-core/src/trace/W3CTraceContextPropagator.ts, https://github.com/open-telemetry/opentelemetry-js/blob/main/doc/sdk-registration.md, https://opentelemetry.io/docs/languages/js/instrumentation/, https://opentelemetry.io/docs/languages/js/context/index.md
- AWS SDK for JS v3 (`client-s3`, `s3-request-presigner`, checksums, effective practices): https://github.com/aws/aws-sdk-js-v3/blob/main/packages/s3-request-presigner/README.md, https://github.com/aws/aws-sdk-js-v3/blob/main/supplemental-docs/EFFECTIVE_PRACTICES.md, https://github.com/aws/aws-sdk-js-v3/blob/main/supplemental-docs/CLIENTS.md, https://github.com/aws/aws-sdk-js-v3/blob/main/packages-internal/checksums/src/submodules/flexible-checksums/flexibleChecksumsMiddleware.ts, https://github.com/aws/aws-sdk-js-v3/blob/main/clients/client-s3/src/commands/PutObjectCommand.ts, https://github.com/aws/aws-sdk-js-v3/blob/main/clients/client-s3/test/unit/S3.spec.ts, https://github.com/aws/aws-sdk-js-v3/issues/6810
- `aws4fetch` v1.0.20: https://github.com/mhart/aws4fetch/blob/v1.0.20/README.md, https://github.com/mhart/aws4fetch/blob/main/src/main.js
- `minio-js`: https://github.com/minio/minio-js/blob/master/_autodocs/api-reference/overview.md, https://github.com/minio/minio-js/blob/master/_autodocs/api-reference/client.md, https://github.com/minio/minio-js/blob/master/_autodocs/api-reference/client-object-operations.md, https://github.com/minio/minio-js/blob/master/_autodocs/configuration.md
- Cloudflare R2 S3 API Docs: https://developers.cloudflare.com/r2/api/s3/api/, https://developers.cloudflare.com/r2/api/s3/presigned-urls/, https://developers.cloudflare.com/r2/examples/aws/aws-sdk-js-v3/, https://developers.cloudflare.com/r2/examples/aws/aws4fetch/
- MinIO Upstream Repository (archived April 25, 2026): https://github.com/minio/minio
