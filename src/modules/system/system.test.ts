import { testClient } from "hono/testing";
import { afterEach, describe, expect, it } from "vitest";

import { createTestApp } from "../../../tests/helpers/test-app";

describe("system module", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cleanups.length > 0) {
      await cleanups.pop()?.();
    }
  });

  it("serves service metadata on GET / and liveness on GET /health via typed testClient", async () => {
    const ctx = await createTestApp({ APP_NAME: "Custom Starter" });
    cleanups.push(ctx.cleanup);

    const client = testClient(ctx.app);

    const rootRes = await client.index.$get();
    expect(rootRes.status).toBe(200);
    expect(await rootRes.json()).toEqual({
      name: "Custom Starter",
      status: "ok",
    });

    const healthRes = await client.health.$get();
    expect(healthRes.status).toBe(200);
    const healthBody = await healthRes.json();
    expect(healthBody.status).toBe("ok");
    expect(Number.isNaN(Date.parse(healthBody.timestamp))).toBe(false);
  });

  it("serves OpenAPI 3.0.0 spec on GET /doc with securitySchemes", async () => {
    const ctx = await createTestApp({ APP_NAME: "My API" });
    cleanups.push(ctx.cleanup);

    const res = await ctx.app.request("/doc");
    expect(res.status).toBe(200);

    const doc = await res.json();
    expect(doc.openapi).toBe("3.0.0");
    expect(doc.info.title).toBe("My API");
    expect(doc.components?.securitySchemes).toMatchObject({
      bearerAuth: { type: "http", scheme: "bearer" },
      cookieAuth: { type: "apiKey", in: "cookie", name: "better-auth.session_token" },
    });
    expect(doc.paths).toHaveProperty("/");
    expect(doc.paths).toHaveProperty("/health");
    expect(doc.paths).toHaveProperty("/ready");
    expect(doc.paths).not.toHaveProperty("/metrics");
  });

  it("returns 200 on GET /ready when DB is healthy and redis is skipped", async () => {
    const ctx = await createTestApp();
    cleanups.push(ctx.cleanup);

    const res = await ctx.client.ready.$get();
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.status).toBe("ok");
    expect(Number.isNaN(Date.parse(body.timestamp))).toBe(false);
    expect(body.checks.db.status).toBe("ok");
    expect(typeof body.checks.db.latencyMs).toBe("number");
    expect(body.checks.redis).toEqual({ status: "skipped" });
  });

  it("returns 503 on GET /ready when DB probe fails without leaking internal errors", async () => {
    const ctx = await createTestApp();
    cleanups.push(ctx.cleanup);

    ctx.container.client.close();

    const res = await ctx.client.ready.$get();
    expect(res.status).toBe(503);

    const text = await res.text();
    expect(text).not.toContain("SQLITE");
    expect(text).not.toContain("closed");
    const body = JSON.parse(text);
    expect(body.status).toBe("unhealthy");
    expect(body.checks.db.status).toBe("error");
    expect(body.checks.redis).toEqual({ status: "skipped" });
  });

  it("returns 503 on GET /ready when DB probe times out or app is shutting down", async () => {
    let shuttingDown = false;
    const slowCtx = await createTestApp(
      { READINESS_TIMEOUT_MS: 20 },
      {
        checkDb: () => new Promise(() => {}),
        isShuttingDown: () => shuttingDown,
      },
    );
    cleanups.push(slowCtx.cleanup);

    const timeoutRes = await slowCtx.client.ready.$get();
    expect(timeoutRes.status).toBe(503);
    const timeoutBody = await timeoutRes.json();
    expect(timeoutBody.status).toBe("unhealthy");
    expect(timeoutBody.checks.db.status).toBe("error");

    shuttingDown = true;
    const shutdownRes = await slowCtx.client.ready.$get();
    expect(shutdownRes.status).toBe(503);
    const shutdownBody = await shutdownRes.json();
    expect(shutdownBody.status).toBe("unhealthy");
  });

  it("exposes Prometheus metrics on GET /metrics, excludes probes, and labels unmatched 404s", async () => {
    const ctx = await createTestApp();
    cleanups.push(ctx.cleanup);

    await ctx.app.request("/");
    await ctx.app.request("/api/v1/me");
    await ctx.app.request("/health");
    await ctx.app.request("/ready");
    await ctx.app.request("/favicon.ico");
    await ctx.app.request("/does-not-exist");

    const metricsRes = await ctx.app.request("/metrics");
    expect(metricsRes.status).toBe(200);
    expect(metricsRes.headers.get("content-type")).toContain("text/plain");
    expect(metricsRes.headers.get("content-type")).toContain("0.0.4");

    const body = await metricsRes.text();
    expect(body).toContain("http_requests_total{method=\"GET\",route=\"/\",status=\"200\"} 1");
    expect(body).toContain("http_request_duration_seconds_count{method=\"GET\",route=\"/\",status=\"200\"} 1");
    expect(body).toContain("http_requests_total{method=\"GET\",route=\"/api/v1/me\",status=\"401\"} 1");
    expect(body).toContain("http_requests_total{method=\"GET\",route=\"__unmatched__\",status=\"404\"} 1");
    expect(body).not.toContain("route=\"/health\"");
    expect(body).not.toContain("route=\"/ready\"");
    expect(body).not.toContain("route=\"/favicon.ico\"");
    expect(body).not.toContain("route=\"/metrics\"");
    expect(body).not.toContain("route=\"/does-not-exist\"");
  });

  it("enforces METRICS_TOKEN on GET /metrics and returns 404 when METRICS_ENABLED=false", async () => {
    const authedCtx = await createTestApp({
      METRICS_ENABLED: true,
      METRICS_TOKEN: "top-secret-metrics-token",
    });
    cleanups.push(authedCtx.cleanup);

    const missingTokenRes = await authedCtx.app.request("/metrics", {
      headers: { "X-Request-Id": "req-metrics-noauth" },
    });
    expect(missingTokenRes.status).toBe(401);
    expect(await missingTokenRes.json()).toEqual({
      error: {
        code: "UNAUTHORIZED",
        message: "Unauthorized",
        requestId: "req-metrics-noauth",
      },
    });

    const wrongTokenRes = await authedCtx.app.request("/metrics", {
      headers: { Authorization: "Bearer wrong-token" },
    });
    expect(wrongTokenRes.status).toBe(401);

    const validTokenRes = await authedCtx.app.request("/metrics", {
      headers: { Authorization: "Bearer top-secret-metrics-token" },
    });
    expect(validTokenRes.status).toBe(200);

    const disabledCtx = await createTestApp({
      METRICS_ENABLED: false,
      METRICS_TOKEN: "top-secret-metrics-token",
    });
    cleanups.push(disabledCtx.cleanup);

    const disabledRes = await disabledCtx.app.request("/metrics", {
      headers: {
        "Authorization": "Bearer top-secret-metrics-token",
        "X-Request-Id": "req-metrics-disabled",
      },
    });
    expect(disabledRes.status).toBe(404);
    expect(await disabledRes.json()).toMatchObject({
      error: {
        code: "NOT_FOUND",
        requestId: "req-metrics-disabled",
      },
    });
  });

  it("isolates metric registries across parallel createTestApp instances", async () => {
    const [ctxA, ctxB] = await Promise.all([createTestApp(), createTestApp()]);
    cleanups.push(ctxA.cleanup, ctxB.cleanup);

    await ctxA.app.request("/");
    await ctxB.app.request("/unknown-in-b");

    const [resA, resB] = await Promise.all([
      ctxA.app.request("/metrics"),
      ctxB.app.request("/metrics"),
    ]);
    const [metricsA, metricsB] = await Promise.all([
      resA.text(),
      resB.text(),
    ]);

    expect(metricsA).toContain("http_requests_total{method=\"GET\",route=\"/\",status=\"200\"} 1");
    expect(metricsA).not.toContain("__unmatched__");

    expect(metricsB).toContain("http_requests_total{method=\"GET\",route=\"__unmatched__\",status=\"404\"} 1");
    expect(metricsB).not.toContain("route=\"/\"");
  });
});
